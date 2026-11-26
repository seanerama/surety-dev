// A small DOM for running the planner page under Node without a browser.
// It covers the parts of the DOM a plain HTML/JS page commonly uses: parsing,
// tree manipulation, selectors, events with capture and bubbling, form
// controls and their values, inline style, dataset and classList.

import { parseSelector, matchesSelector, querySelectorAll } from './selectors.mjs';

export const HTML_NS = 'http://www.w3.org/1999/xhtml';
export const SVG_NS = 'http://www.w3.org/2000/svg';

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style']);
const RCDATA = new Set(['textarea', 'title']);

let reportError = (e) => { throw e; };
export function setErrorReporter(fn) { reportError = fn; }

// ---------------------------------------------------------------- events

export class Event {
  constructor(type, init = {}) {
    this.type = String(type);
    this.bubbles = !!init.bubbles;
    this.cancelable = !!init.cancelable;
    this.composed = !!init.composed;
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this.eventPhase = 0;
    this.isTrusted = false;
    this.timeStamp = Date.now();
    this._stop = false;
    this._stopImm = false;
    this._path = [];
  }
  get srcElement() { return this.target; }
  get cancelBubble() { return this._stop; }
  set cancelBubble(v) { if (v) this._stop = true; }
  get returnValue() { return !this.defaultPrevented; }
  set returnValue(v) { if (!v) this.preventDefault(); }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() { this._stop = true; }
  stopImmediatePropagation() { this._stop = true; this._stopImm = true; }
  composedPath() { return this._path.slice(); }
  initEvent(type, bubbles, cancelable) { this.type = type; this.bubbles = !!bubbles; this.cancelable = !!cancelable; }
}
Event.NONE = 0; Event.CAPTURING_PHASE = 1; Event.AT_TARGET = 2; Event.BUBBLING_PHASE = 3;

export class CustomEvent extends Event {
  constructor(type, init = {}) { super(type, init); this.detail = init.detail ?? null; }
}
export class UIEvent extends Event {
  constructor(type, init = {}) { super(type, init); this.detail = init.detail ?? 0; this.view = init.view ?? null; }
}
export class MouseEvent extends UIEvent {
  constructor(type, init = {}) {
    super(type, init);
    for (const k of ['screenX', 'screenY', 'clientX', 'clientY', 'button', 'buttons']) this[k] = init[k] ?? 0;
    for (const k of ['ctrlKey', 'shiftKey', 'altKey', 'metaKey']) this[k] = !!init[k];
    this.relatedTarget = init.relatedTarget ?? null;
  }
  get pageX() { return this.clientX; }
  get pageY() { return this.clientY; }
  get offsetX() { return 0; }
  get offsetY() { return 0; }
}
export class PointerEvent extends MouseEvent {}
export class KeyboardEvent extends UIEvent {
  constructor(type, init = {}) {
    super(type, init);
    this.key = init.key ?? '';
    this.code = init.code ?? '';
    this.repeat = !!init.repeat;
    this.isComposing = !!init.isComposing;
    for (const k of ['ctrlKey', 'shiftKey', 'altKey', 'metaKey']) this[k] = !!init[k];
  }
  getModifierState() { return false; }
}
export class InputEvent extends UIEvent {
  constructor(type, init = {}) { super(type, init); this.data = init.data ?? null; this.inputType = init.inputType ?? ''; this.isComposing = false; }
}
export class FocusEvent extends UIEvent {
  constructor(type, init = {}) { super(type, init); this.relatedTarget = init.relatedTarget ?? null; }
}
export class SubmitEvent extends Event {
  constructor(type, init = {}) { super(type, init); this.submitter = init.submitter ?? null; }
}

export class EventTarget {
  constructor() { Object.defineProperty(this, '_listeners', { value: new Map(), enumerable: false, writable: true }); }
  addEventListener(type, fn, opts) {
    if (!fn) return;
    const capture = typeof opts === 'boolean' ? opts : !!(opts && opts.capture);
    const once = !!(opts && typeof opts === 'object' && opts.once);
    let list = this._listeners.get(type);
    if (!list) { list = []; this._listeners.set(type, list); }
    if (list.some((l) => l.fn === fn && l.capture === capture)) return;
    const entry = { fn, capture, once };
    list.push(entry);
    const signal = opts && typeof opts === 'object' ? opts.signal : null;
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', () => this.removeEventListener(type, fn, { capture }));
    }
  }
  removeEventListener(type, fn, opts) {
    const capture = typeof opts === 'boolean' ? opts : !!(opts && opts.capture);
    const list = this._listeners.get(type);
    if (!list) return;
    const i = list.findIndex((l) => l.fn === fn && l.capture === capture);
    if (i >= 0) list.splice(i, 1);
  }
  _eventParent() { return null; }
  _handlerHost() { return this; }
  dispatchEvent(ev) {
    if (!(ev instanceof Event)) throw new TypeError('dispatchEvent needs an Event');
    ev.target = this;
    const path = [];
    for (let n = this; n; n = n._eventParent()) path.push(n);
    ev._path = path;
    const invoke = (node, phase) => {
      if (ev._stop && node !== ev.currentTarget) return;
      ev.currentTarget = node;
      ev.eventPhase = phase;
      const list = (node._listeners.get(ev.type) || []).slice();
      const host = node._handlerHost();
      const handler = host && host['on' + ev.type];
      const run = (fn, isHandler) => {
        try {
          const r = typeof fn === 'function' ? fn.call(host || node, ev) : fn.handleEvent(ev);
          if (isHandler && r === false) ev.preventDefault();
          if (r && typeof r.then === 'function') r.then(null, (e) => reportError(e));
        } catch (e) { reportError(e); }
      };
      if (phase !== 1 && typeof handler === 'function') run(handler, true);
      for (const l of list) {
        if (ev._stopImm) break;
        if (phase === 1 && !l.capture) continue;
        if (phase === 3 && l.capture) continue;
        if (l.once) node.removeEventListener(ev.type, l.fn, { capture: l.capture });
        run(l.fn, false);
      }
    };
    for (let i = path.length - 1; i > 0 && !ev._stop; i--) invoke(path[i], 1);
    if (!ev._stop) invoke(path[0], 2);
    if (ev.bubbles) for (let i = 1; i < path.length && !ev._stop; i++) invoke(path[i], 3);
    ev.currentTarget = null;
    ev.eventPhase = 0;
    return !ev.defaultPrevented;
  }
}

// ---------------------------------------------------------------- nodes

function toNode(doc, x) { return x instanceof Node ? x : doc.createTextNode(String(x)); }

export class Node extends EventTarget {
  constructor(doc) {
    super();
    Object.defineProperty(this, 'ownerDocument', { value: doc, writable: true, enumerable: false });
    this.parentNode = null;
    this.childNodes = [];
  }
  _eventParent() {
    if (this.parentNode) return this.parentNode;
    if (this.nodeType === 9) return this.defaultView ? this.defaultView._target : null;
    return null;
  }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get nextSibling() { const p = this.parentNode; if (!p) return null; return p.childNodes[p.childNodes.indexOf(this) + 1] || null; }
  get previousSibling() { const p = this.parentNode; if (!p) return null; return p.childNodes[p.childNodes.indexOf(this) - 1] || null; }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get childElementCount() { return this.children.length; }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { const c = this.children; return c[c.length - 1] || null; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n.nodeType === 9; }
  get nodeValue() { return null; }
  set nodeValue(v) {}
  getRootNode() { let n = this; while (n.parentNode) n = n.parentNode; return n; }
  hasChildNodes() { return this.childNodes.length > 0; }
  contains(o) { for (let n = o; n; n = n.parentNode) if (n === this) return true; return false; }
  get textContent() {
    let s = '';
    const walk = (n) => { for (const c of n.childNodes) { if (c.nodeType === 3) s += c.data; else if (c.nodeType === 1 || c.nodeType === 11) walk(c); } };
    walk(this);
    return s;
  }
  set textContent(v) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    const s = v == null ? '' : String(v);
    if (s !== '') this.appendChild(this.ownerDocument.createTextNode(s));
    this._changed();
  }
  get innerText() { return this.textContent; }
  set innerText(v) { this.textContent = v; }
  _changed() {}
  _insert(node, index) {
    if (node.nodeType === 11) {
      const kids = node.childNodes.slice();
      for (const k of kids) { this._insert(k, index); index++; }
      return node;
    }
    if (node.contains(this)) throw new Error('HierarchyRequestError');
    if (node.parentNode) {
      const op = node.parentNode;
      const oi = op.childNodes.indexOf(node);
      op.childNodes.splice(oi, 1);
      if (op === this && oi < index) index--;
      op._changed();
    }
    node.parentNode = this;
    this.childNodes.splice(index, 0, node);
    this._changed();
    return node;
  }
  appendChild(node) { this._insert(node, this.childNodes.length); return node; }
  insertBefore(node, ref) {
    if (ref == null) return this.appendChild(node);
    const i = this.childNodes.indexOf(ref);
    if (i < 0) throw new Error('NotFoundError');
    this._insert(node, i);
    return node;
  }
  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i < 0) throw new Error('NotFoundError');
    this.childNodes.splice(i, 1);
    node.parentNode = null;
    this._changed();
    return node;
  }
  replaceChild(node, old) { this.insertBefore(node, old); if (old.parentNode === this) this.removeChild(old); return old; }
  append(...nodes) { for (const n of nodes) this.appendChild(toNode(this.ownerDocument || this, n)); }
  prepend(...nodes) { const f = this._doc().createDocumentFragment(); f.append(...nodes); this.insertBefore(f, this.firstChild); }
  replaceChildren(...nodes) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; this.append(...nodes); this._changed(); }
  _doc() { return this.nodeType === 9 ? this : this.ownerDocument; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  before(...nodes) { const p = this.parentNode; if (!p) return; const f = this._doc().createDocumentFragment(); f.append(...nodes); p.insertBefore(f, this); }
  after(...nodes) { const p = this.parentNode; if (!p) return; const f = this._doc().createDocumentFragment(); f.append(...nodes); p.insertBefore(f, this.nextSibling); }
  replaceWith(...nodes) { const p = this.parentNode; if (!p) return; const f = this._doc().createDocumentFragment(); f.append(...nodes); p.insertBefore(f, this); if (this.parentNode === p) p.removeChild(this); }
  cloneNode(deep) {
    const c = this._shallowClone();
    if (deep) for (const k of this.childNodes) c.appendChild(k.cloneNode(true));
    if (this.localName === 'template' && deep) for (const k of this.content.childNodes) c.content.appendChild(k.cloneNode(true));
    return c;
  }
  isSameNode(o) { return o === this; }
  isEqualNode(o) { return !!o && o.outerHTML === this.outerHTML; }
  normalize() {}
  compareDocumentPosition(o) {
    if (o === this) return 0;
    if (this.contains(o)) return 20;
    if (o.contains(this)) return 10;
    const all = [];
    const walk = (n) => { all.push(n); for (const c of n.childNodes) walk(c); };
    walk(this.getRootNode());
    const a = all.indexOf(this); const b = all.indexOf(o);
    if (b < 0) return 1;
    return b > a ? 4 : 2;
  }
  querySelectorAll(sel) { return querySelectorAll(this, parseSelector(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  getElementsByTagName(t) { return t === '*' ? this.querySelectorAll('*') : this.querySelectorAll(String(t).replace(/[^\w-]/g, '')); }
  getElementsByClassName(c) { return this.querySelectorAll(String(c).trim().split(/\s+/).map((x) => '.' + cssEscape(x)).join('')); }
}
Node.ELEMENT_NODE = 1; Node.TEXT_NODE = 3; Node.COMMENT_NODE = 8; Node.DOCUMENT_NODE = 9; Node.DOCUMENT_FRAGMENT_NODE = 11;
Node.DOCUMENT_POSITION_PRECEDING = 2; Node.DOCUMENT_POSITION_FOLLOWING = 4; Node.DOCUMENT_POSITION_CONTAINS = 8; Node.DOCUMENT_POSITION_CONTAINED_BY = 16;

export function cssEscape(s) { return String(s).replace(/([^\w-])/g, '\\$1').replace(/^(\d)/, '\\3$1 '); }

export class CharacterData extends Node {
  constructor(doc, data) { super(doc); this.data = String(data); }
  get nodeValue() { return this.data; }
  set nodeValue(v) { this.data = String(v); }
  get textContent() { return this.data; }
  set textContent(v) { this.data = v == null ? '' : String(v); }
  get length() { return this.data.length; }
  appendData(s) { this.data += s; }
}
export class Text extends CharacterData {
  get nodeType() { return 3; }
  get nodeName() { return '#text'; }
  get wholeText() { return this.data; }
  _shallowClone() { return new Text(this.ownerDocument, this.data); }
}
export class Comment extends CharacterData {
  get nodeType() { return 8; }
  get nodeName() { return '#comment'; }
  _shallowClone() { return new Comment(this.ownerDocument, this.data); }
}
export class DocumentFragment extends Node {
  get nodeType() { return 11; }
  get nodeName() { return '#document-fragment'; }
  _shallowClone() { return new DocumentFragment(this.ownerDocument); }
  getElementById(id) { return this.querySelectorAll('*').find((e) => e.id === id) || null; }
  get innerHTML() { return this.childNodes.map(serialize).join(''); }
}

// ---------------------------------------------------------------- style

function camelToKebab(p) {
  if (p.startsWith('--')) return p;
  if (p === 'cssFloat') return 'float';
  return p.replace(/^(webkit|moz|ms)(?=[A-Z])/, '-$1').replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
}
export function parseDeclarations(text) {
  const out = [];
  let depth = 0; let quote = null; let cur = '';
  const push = () => {
    const i = cur.indexOf(':');
    if (i > 0) {
      let prop = cur.slice(0, i).trim();
      let value = cur.slice(i + 1).trim();
      let important = false;
      const m = /!\s*important\s*$/i.exec(value);
      if (m) { important = true; value = value.slice(0, m.index).trim(); }
      if (!prop.startsWith('--')) prop = prop.toLowerCase();
      if (prop) out.push({ prop, value, important });
    }
    cur = '';
  };
  for (const ch of String(text)) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ';' && depth <= 0) { push(); continue; }
    cur += ch;
  }
  push();
  return out;
}
function makeStyle(el) {
  const read = () => {
    const m = new Map();
    for (const d of parseDeclarations(el.getAttribute('style') || '')) m.set(d.prop, d);
    return m;
  };
  const write = (m) => {
    const s = [...m.values()].map((d) => `${d.prop}: ${d.value}${d.important ? ' !important' : ''};`).join(' ');
    if (s) el.setAttribute('style', s); else el.removeAttribute('style');
  };
  const api = {
    getPropertyValue(p) { const d = read().get(p.startsWith('--') ? p : p.toLowerCase()); return d ? d.value : ''; },
    getPropertyPriority(p) { const d = read().get(p); return d && d.important ? 'important' : ''; },
    setProperty(p, v, prio) {
      const m = read();
      const key = p.startsWith('--') ? p : p.toLowerCase();
      if (v == null || v === '') m.delete(key); else m.set(key, { prop: key, value: String(v), important: prio === 'important' });
      write(m);
    },
    removeProperty(p) { const m = read(); const d = m.get(p); m.delete(p); write(m); return d ? d.value : ''; },
    item(i) { return [...read().keys()][i] || ''; },
  };
  return new Proxy(api, {
    get(t, p) {
      if (typeof p === 'symbol') return undefined;
      if (p in t) return t[p];
      if (p === 'cssText') return el.getAttribute('style') || '';
      if (p === 'length') return read().size;
      if (/^\d+$/.test(p)) return t.item(Number(p));
      return t.getPropertyValue(camelToKebab(p));
    },
    set(t, p, v) {
      if (p === 'cssText') { if (v) el.setAttribute('style', String(v)); else el.removeAttribute('style'); return true; }
      t.setProperty(camelToKebab(p), v === null ? '' : typeof v === 'number' ? String(v) : v);
      return true;
    },
  });
}

// ---------------------------------------------------------------- elements

class DOMTokenList {
  constructor(el, attr) { this._el = el; this._attr = attr; }
  _get() { return (this._el.getAttribute(this._attr) || '').split(/\s+/).filter(Boolean); }
  _set(list) { this._el.setAttribute(this._attr, [...new Set(list)].join(' ')); }
  get length() { return this._get().length; }
  get value() { return this._el.getAttribute(this._attr) || ''; }
  set value(v) { this._el.setAttribute(this._attr, v); }
  item(i) { return this._get()[i] ?? null; }
  contains(c) { return this._get().includes(c); }
  add(...cs) { const l = this._get(); for (const c of cs) if (!l.includes(c)) l.push(c); this._set(l); }
  remove(...cs) { this._set(this._get().filter((c) => !cs.includes(c))); }
  toggle(c, force) {
    const has = this.contains(c);
    const want = force === undefined ? !has : !!force;
    if (want && !has) this.add(c);
    if (!want && has) this.remove(c);
    return want;
  }
  replace(a, b) { const l = this._get(); const i = l.indexOf(a); if (i < 0) return false; l[i] = b; this._set(l); return true; }
  forEach(fn) { this._get().forEach(fn); }
  toString() { return this.value; }
  [Symbol.iterator]() { return this._get()[Symbol.iterator](); }
}

function datasetProxy(el) {
  const toAttr = (p) => 'data-' + p.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
  const toProp = (a) => a.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  return new Proxy({}, {
    get(_, p) { if (typeof p !== 'string') return undefined; const v = el.getAttribute(toAttr(p)); return v === null ? undefined : v; },
    set(_, p, v) { el.setAttribute(toAttr(p), String(v)); return true; },
    deleteProperty(_, p) { el.removeAttribute(toAttr(p)); return true; },
    has(_, p) { return el.hasAttribute(toAttr(p)); },
    ownKeys() { return el.getAttributeNames().filter((a) => a.startsWith('data-')).map(toProp); },
    getOwnPropertyDescriptor(_, p) {
      const v = el.getAttribute(toAttr(p));
      return v === null ? undefined : { value: v, enumerable: true, configurable: true, writable: true };
    },
  });
}

const REFLECT_STRING = ['title', 'lang', 'dir', 'name', 'placeholder', 'href', 'src', 'alt', 'rel', 'target', 'role', 'min', 'max', 'step', 'pattern', 'autocomplete', 'inputMode:inputmode', 'htmlFor:for', 'accessKey:accesskey', 'action', 'method', 'enctype', 'label', 'media', 'download', 'width', 'height', 'colSpan:colspan', 'rowSpan:rowspan', 'scope', 'headers', 'form_:form', 'list_:list', 'ariaLabel:aria-label', 'ariaLive:aria-live', 'ariaHidden:aria-hidden', 'ariaPressed:aria-pressed', 'ariaExpanded:aria-expanded', 'ariaInvalid:aria-invalid', 'ariaDescribedBy:aria-describedby'];
const REFLECT_BOOL = ['hidden', 'disabled', 'required', 'readOnly:readonly', 'multiple', 'autofocus', 'noValidate:novalidate', 'open', 'inert', 'defer', 'async', 'reversed', 'formNoValidate:formnovalidate'];

export class Element extends Node {
  constructor(doc, localName, ns = HTML_NS) {
    super(doc);
    this.namespaceURI = ns;
    this.localName = ns === HTML_NS ? String(localName).toLowerCase() : String(localName);
    Object.defineProperty(this, '_attrs', { value: new Map(), enumerable: false, writable: true });
    Object.defineProperty(this, '_style', { value: null, enumerable: false, writable: true });
  }
  get nodeType() { return 1; }
  get tagName() { return this.namespaceURI === HTML_NS ? this.localName.toUpperCase() : this.localName; }
  get nodeName() { return this.tagName; }
  _shallowClone() {
    const c = this.ownerDocument.createElementNS(this.namespaceURI, this.localName);
    for (const [k, v] of this._attrs) c._attrs.set(k, v);
    if ('_value' in this && this._value !== undefined) c._value = this._value;
    return c;
  }
  _norm(n) { n = String(n); return this.namespaceURI === HTML_NS ? n.toLowerCase() : n; }
  getAttribute(n) { const v = this._attrs.get(this._norm(n)); return v === undefined ? null : v; }
  setAttribute(n, v) { this._attrs.set(this._norm(n), String(v)); this._changed(); }
  removeAttribute(n) { this._attrs.delete(this._norm(n)); this._changed(); }
  hasAttribute(n) { return this._attrs.has(this._norm(n)); }
  hasAttributes() { return this._attrs.size > 0; }
  toggleAttribute(n, force) {
    const has = this.hasAttribute(n);
    const want = force === undefined ? !has : !!force;
    if (want && !has) this.setAttribute(n, '');
    if (!want && has) this.removeAttribute(n);
    return want;
  }
  getAttributeNames() { return [...this._attrs.keys()]; }
  getAttributeNS(_, n) { return this.getAttribute(n); }
  setAttributeNS(_, n, v) { this.setAttribute(n.replace(/^\w+:/, ''), v); }
  removeAttributeNS(_, n) { this.removeAttribute(n); }
  get attributes() {
    const list = [...this._attrs].map(([name, value]) => ({ name, value, localName: name, nodeName: name }));
    list.getNamedItem = (n) => list.find((a) => a.name === n) || null;
    list.item = (i) => list[i] || null;
    return list;
  }
  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  get classList() { return new DOMTokenList(this, 'class'); }
  get relList() { return new DOMTokenList(this, 'rel'); }
  get dataset() { return datasetProxy(this); }
  get style() { if (!this._style) this._style = makeStyle(this); return this._style; }
  set style(v) { this.setAttribute('style', String(v)); }
  get tabIndex() { const v = this.getAttribute('tabindex'); return v === null ? (/^(a|button|input|select|textarea)$/.test(this.localName) ? 0 : -1) : Number(v); }
  set tabIndex(v) { this.setAttribute('tabindex', v); }
  get innerHTML() { return (this.localName === 'template' ? this.content.childNodes : this.childNodes).map(serialize).join(''); }
  set innerHTML(html) {
    const target = this.localName === 'template' ? this.content : this;
    for (const c of target.childNodes) c.parentNode = null;
    target.childNodes = [];
    parseHTMLInto(this.ownerDocument, String(html ?? ''), target);
    this._changed();
  }
  get outerHTML() { return serialize(this); }
  set outerHTML(html) {
    const f = this.ownerDocument.createDocumentFragment();
    parseHTMLInto(this.ownerDocument, String(html), f);
    this.replaceWith(f);
  }
  insertAdjacentHTML(pos, html) {
    const f = this.ownerDocument.createDocumentFragment();
    parseHTMLInto(this.ownerDocument, String(html), f);
    this._adjacent(pos, f);
  }
  insertAdjacentElement(pos, el) { this._adjacent(pos, el); return el; }
  insertAdjacentText(pos, t) { this._adjacent(pos, this.ownerDocument.createTextNode(t)); }
  _adjacent(pos, node) {
    switch (String(pos).toLowerCase()) {
      case 'beforebegin': this.parentNode && this.parentNode.insertBefore(node, this); break;
      case 'afterbegin': this.insertBefore(node, this.firstChild); break;
      case 'beforeend': this.appendChild(node); break;
      case 'afterend': this.parentNode && this.parentNode.insertBefore(node, this.nextSibling); break;
      default: throw new Error('SyntaxError: ' + pos);
    }
  }
  get nextElementSibling() { let n = this.nextSibling; while (n && n.nodeType !== 1) n = n.nextSibling; return n; }
  get previousElementSibling() { let n = this.previousSibling; while (n && n.nodeType !== 1) n = n.previousSibling; return n; }
  matches(sel) { return matchesSelector(this, parseSelector(sel)); }
  webkitMatchesSelector(sel) { return this.matches(sel); }
  closest(sel) { const s = parseSelector(sel); for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (matchesSelector(n, s)) return n; return null; }
  click() {
    if (this.disabled) return;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, button: 0, detail: 1 });
    this.ownerDocument._clicked = (this.ownerDocument._clicked || 0) + 1;
    const ok = this.dispatchEvent(ev);
    if (ok) this._activate(ev);
  }
  _activate() {
    if (this.localName === 'label') { const c = this.control; if (c && c !== this) { c.focus(); c.click(); } }
    if (this.localName === 'summary' && this.parentNode && this.parentNode.localName === 'details') this.parentNode.toggleAttribute('open');
  }
  focus() {
    const doc = this.ownerDocument;
    const prev = doc._active;
    if (prev === this) return;
    if (prev && prev !== doc.body) prev.blur();
    doc._active = this;
    this.dispatchEvent(new FocusEvent('focus', {}));
    this.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  }
  blur() {
    const doc = this.ownerDocument;
    if (doc._active !== this) return;
    doc._active = null;
    this.dispatchEvent(new FocusEvent('blur', {}));
    this.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  }
  getBoundingClientRect() { return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() { return this; } }; }
  getClientRects() { return []; }
  scrollIntoView() {}
  scrollTo() {}
  scrollBy() {}
  animate() { return { finished: Promise.resolve(), cancel() {}, finish() {}, play() {}, pause() {}, addEventListener() {}, onfinish: null }; }
  getAnimations() { return []; }
  attachShadow() { throw new Error('attachShadow is not supported by the check DOM'); }
  get offsetWidth() { return 0; }
  get offsetHeight() { return 0; }
  get clientWidth() { return 0; }
  get clientHeight() { return 0; }
  get scrollWidth() { return 0; }
  get scrollHeight() { return 0; }
  get offsetParent() { return this.parentElement; }
  get isContentEditable() { return false; }
  get labels() {
    const doc = this.ownerDocument;
    const out = [];
    if (this.id) for (const l of doc.querySelectorAll('label')) if (l.getAttribute('for') === this.id) out.push(l);
    for (let n = this.parentNode; n && n.nodeType === 1; n = n.parentNode) if (n.localName === 'label' && !n.hasAttribute('for')) out.push(n);
    return out;
  }
  get form() {
    const fid = this.getAttribute('form');
    if (fid) return this.ownerDocument.getElementById(fid);
    for (let n = this.parentNode; n && n.nodeType === 1; n = n.parentNode) if (n.localName === 'form') return n;
    return null;
  }
}
for (const spec of REFLECT_STRING) {
  const [prop, attr = spec.toLowerCase()] = spec.split(':');
  const p = prop.replace(/_$/, '');
  if (prop.endsWith('_')) continue;
  if (Object.getOwnPropertyDescriptor(Element.prototype, p)) continue;
  Object.defineProperty(Element.prototype, p, {
    get() { return this.getAttribute(attr) ?? ''; },
    set(v) { this.setAttribute(attr, v); },
    configurable: true,
  });
}
for (const spec of REFLECT_BOOL) {
  const [prop, attr = spec.toLowerCase()] = spec.split(':');
  Object.defineProperty(Element.prototype, prop, {
    get() { return this.hasAttribute(attr); },
    set(v) { this.toggleAttribute(attr, !!v); },
    configurable: true,
  });
}

export class HTMLElement extends Element {}
export class SVGElement extends Element {}
export class HTMLDivElement extends HTMLElement {}
export class HTMLSpanElement extends HTMLElement {}
export class HTMLParagraphElement extends HTMLElement {}
export class HTMLHeadingElement extends HTMLElement {}
export class HTMLUListElement extends HTMLElement {}
export class HTMLOListElement extends HTMLElement {}
export class HTMLLIElement extends HTMLElement {}
export class HTMLTableElement extends HTMLElement {}
export class HTMLTableRowElement extends HTMLElement {}
export class HTMLTableCellElement extends HTMLElement {}
export class HTMLTableSectionElement extends HTMLElement {}
export class HTMLAnchorElement extends HTMLElement {}
export class HTMLImageElement extends HTMLElement {}
export class HTMLScriptElement extends HTMLElement {}
export class HTMLStyleElement extends HTMLElement {}
export class HTMLLinkElement extends HTMLElement {}
export class HTMLBodyElement extends HTMLElement {}
export class HTMLHtmlElement extends HTMLElement {}
export class HTMLHeadElement extends HTMLElement {}
export class HTMLFieldSetElement extends HTMLElement {
  get elements() { return controlsOf(this); }
}
export class HTMLLegendElement extends HTMLElement {}
export class HTMLOutputElement extends HTMLElement {
  get value() { return this.textContent; }
  set value(v) { this.textContent = v; }
}
export class HTMLCanvasElement extends HTMLElement {
  getContext() { return null; }
  toDataURL() { return ''; }
}
export class HTMLDialogElement extends HTMLElement {
  show() { this.setAttribute('open', ''); }
  showModal() { this.setAttribute('open', ''); }
  close(rv) { if (rv !== undefined) this.returnValue = rv; this.removeAttribute('open'); this.dispatchEvent(new Event('close')); }
}
export class HTMLTemplateElement extends HTMLElement {
  get content() {
    if (!this._content) Object.defineProperty(this, '_content', { value: new DocumentFragment(this.ownerDocument), enumerable: false });
    return this._content;
  }
}
export class HTMLLabelElement extends HTMLElement {
  get control() {
    const f = this.getAttribute('for');
    if (f) return this.ownerDocument.getElementById(f);
    return this.querySelector('input,select,textarea,button');
  }
}

// --- form controls

const LABELABLE = new Set(['input', 'select', 'textarea', 'button', 'output']);
function controlsOf(root) {
  const list = root.querySelectorAll('input,select,textarea,button,fieldset,output');
  const named = {};
  for (const c of list) {
    const n = c.getAttribute('name') || c.id;
    if (n && !(n in named)) named[n] = c;
  }
  list.namedItem = (n) => named[n] || null;
  list.item = (i) => list[i] || null;
  for (const [k, v] of Object.entries(named)) if (!(k in list) || /\D/.test(k)) { try { list[k] = v; } catch {} }
  return list;
}

const NUMERIC_TYPES = new Set(['number', 'range']);
const VALIDATION_MESSAGES = {
  valueMissing: 'Please fill out this field.',
  badInput: 'Please enter a number.',
  rangeUnderflow: 'Value must be greater than or equal to {min}.',
  rangeOverflow: 'Value must be less than or equal to {max}.',
  stepMismatch: 'Please enter a valid value.',
  typeMismatch: 'Please enter a valid value.',
  patternMismatch: 'Please match the requested format.',
};

class FormControl extends HTMLElement {
  get validity() {
    const v = this._validityState();
    v.valid = !Object.entries(v).some(([k, x]) => k !== 'valid' && x);
    return v;
  }
  _validityState() {
    return { valueMissing: false, badInput: false, rangeUnderflow: false, rangeOverflow: false, stepMismatch: false, typeMismatch: false, patternMismatch: false, tooLong: false, tooShort: false, customError: !!this._custom };
  }
  get willValidate() { return !this.disabled && !(this.localName === 'input' && ['hidden', 'button', 'submit', 'reset'].includes(this.type)) && this.localName !== 'button'; }
  get validationMessage() {
    if (!this.willValidate) return '';
    if (this._custom) return this._custom;
    const v = this.validity;
    for (const k of Object.keys(VALIDATION_MESSAGES)) if (v[k]) return VALIDATION_MESSAGES[k].replace('{min}', this.getAttribute('min')).replace('{max}', this.getAttribute('max'));
    return '';
  }
  setCustomValidity(m) { Object.defineProperty(this, '_custom', { value: String(m ?? ''), writable: true, configurable: true, enumerable: false }); }
  checkValidity() {
    if (!this.willValidate || this.validity.valid) return true;
    this.dispatchEvent(new Event('invalid', { cancelable: true }));
    return false;
  }
  reportValidity() {
    const ok = this.checkValidity();
    if (!ok) this.ownerDocument._nativeReports.push({ el: this, message: this.validationMessage });
    return ok;
  }
}

export class HTMLInputElement extends FormControl {
  get type() { const t = (this.getAttribute('type') || 'text').toLowerCase(); return t; }
  set type(v) { this.setAttribute('type', v); }
  get defaultValue() { return this.getAttribute('value') ?? ''; }
  set defaultValue(v) { this.setAttribute('value', v); }
  get value() {
    if (this.type === 'checkbox' || this.type === 'radio') return this.getAttribute('value') ?? 'on';
    return this._value !== undefined ? this._value : (this.getAttribute('value') ?? '');
  }
  set value(v) {
    let s = v == null ? '' : String(v);
    this._bad = false;
    if (NUMERIC_TYPES.has(this.type) && s !== '' && !/^\s*[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i.test(s)) s = '';
    this._setRaw(s);
  }
  _setRaw(s) { Object.defineProperty(this, '_value', { value: s, writable: true, configurable: true, enumerable: false }); }
  // What a user's typing leaves in the field: a number field holding text has
  // an empty value and reports badInput, as browsers do.
  _userType(s) {
    s = String(s);
    if (NUMERIC_TYPES.has(this.type) && s !== '' && !/^\s*[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i.test(s)) {
      this._setRaw('');
      this._bad = true;
    } else { this._setRaw(s); this._bad = false; }
  }
  get valueAsNumber() { const n = parseFloat(this.value); return NUMERIC_TYPES.has(this.type) && this.value !== '' && Number.isFinite(n) ? n : NaN; }
  set valueAsNumber(n) { this.value = Number.isFinite(n) ? String(n) : ''; }
  get checked() { return this._checked !== undefined ? this._checked : this.hasAttribute('checked'); }
  set checked(v) { Object.defineProperty(this, '_checked', { value: !!v, writable: true, configurable: true, enumerable: false }); }
  get defaultChecked() { return this.hasAttribute('checked'); }
  get size() { return Number(this.getAttribute('size') || 20); }
  get list() { const id = this.getAttribute('list'); return id ? this.ownerDocument.getElementById(id) : null; }
  get selectionStart() { return this.value.length; }
  get selectionEnd() { return this.value.length; }
  select() {}
  setSelectionRange() {}
  setRangeText() {}
  stepUp() {}
  stepDown() {}
  showPicker() {}
  _validityState() {
    const v = super._validityState();
    const val = this.value;
    if (this.required && val === '' && !['checkbox', 'radio'].includes(this.type)) v.valueMissing = true;
    if (this.required && this.type === 'checkbox' && !this.checked) v.valueMissing = true;
    if (NUMERIC_TYPES.has(this.type)) {
      v.badInput = !!this._bad;
      const n = parseFloat(val);
      if (val !== '' && Number.isFinite(n)) {
        const min = parseFloat(this.getAttribute('min'));
        const max = parseFloat(this.getAttribute('max'));
        if (Number.isFinite(min) && n < min) v.rangeUnderflow = true;
        if (Number.isFinite(max) && n > max) v.rangeOverflow = true;
        const stepAttr = (this.getAttribute('step') || '1').toLowerCase();
        if (stepAttr !== 'any') {
          const step = parseFloat(stepAttr);
          if (Number.isFinite(step) && step > 0) {
            const base = Number.isFinite(min) ? min : 0;
            const q = (n - base) / step;
            if (Math.abs(q - Math.round(q)) > 1e-7) v.stepMismatch = true;
          }
        }
      }
    }
    const pat = this.getAttribute('pattern');
    if (pat && val !== '') { try { if (!new RegExp(`^(?:${pat})$`, 'u').test(val)) v.patternMismatch = true; } catch {} }
    const minl = Number(this.getAttribute('minlength'));
    if (minl && val !== '' && val.length < minl) v.tooShort = true;
    return v;
  }
  _activate(ev) {
    const t = this.type;
    if (t === 'checkbox') { this.checked = !this.checked; this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true })); }
    if (t === 'radio' && !this.checked) { this._radioGroup().forEach((r) => { r.checked = false; }); this.checked = true; this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true })); }
    if ((t === 'submit' || t === 'image') && this.form) this.form.requestSubmit(this);
    if (t === 'reset' && this.form) this.form.reset();
  }
  _radioGroup() {
    const n = this.getAttribute('name');
    const root = this.form || this.ownerDocument;
    return n ? root.querySelectorAll('input[type=radio]').filter((r) => r.getAttribute('name') === n) : [this];
  }
}
export class HTMLTextAreaElement extends FormControl {
  get type() { return 'textarea'; }
  get defaultValue() { return this.textContent; }
  set defaultValue(v) { this.textContent = v; }
  get value() { return this._value !== undefined ? this._value : this.textContent; }
  set value(v) { Object.defineProperty(this, '_value', { value: v == null ? '' : String(v), writable: true, configurable: true, enumerable: false }); }
  _userType(s) { this.value = s; }
  select() {}
  setSelectionRange() {}
  _validityState() { const v = super._validityState(); if (this.required && this.value === '') v.valueMissing = true; return v; }
}
export class HTMLButtonElement extends FormControl {
  get type() { const t = (this.getAttribute('type') || 'submit').toLowerCase(); return ['submit', 'reset', 'button'].includes(t) ? t : 'submit'; }
  set type(v) { this.setAttribute('type', v); }
  get value() { return this.getAttribute('value') ?? ''; }
  set value(v) { this.setAttribute('value', v); }
  _activate() {
    const f = this.form;
    if (!f) return;
    if (this.type === 'submit') f.requestSubmit(this);
    else if (this.type === 'reset') f.reset();
  }
}
export class HTMLOptionElement extends HTMLElement {
  get value() { return this.getAttribute('value') ?? this.text; }
  set value(v) { this.setAttribute('value', v); }
  get text() { return this.textContent.replace(/\s+/g, ' ').trim(); }
  set text(v) { this.textContent = v; }
  get label() { return this.getAttribute('label') ?? this.text; }
  set label(v) { this.setAttribute('label', v); }
  get defaultSelected() { return this.hasAttribute('selected'); }
  set defaultSelected(v) { this.toggleAttribute('selected', !!v); }
  get _select() { for (let n = this.parentNode; n && n.nodeType === 1; n = n.parentNode) if (n.localName === 'select') return n; return null; }
  get selected() { const s = this._select; return s ? s._selectedOption() === this : (this._sel ?? this.hasAttribute('selected')); }
  set selected(v) {
    const s = this._select;
    if (s && v) for (const o of s.options) o._sel = o === this;
    else this._sel = !!v;
    if (s && !v && s._selectedOption() === this) this._sel = false;
  }
  get index() { const s = this._select; return s ? s.options.indexOf(this) : 0; }
  get form() { const s = this._select; return s ? s.form : null; }
}
export class HTMLOptGroupElement extends HTMLElement {}
export class HTMLSelectElement extends FormControl {
  get type() { return this.multiple ? 'select-multiple' : 'select-one'; }
  get options() {
    const o = this.querySelectorAll('option');
    o.item = (i) => o[i] || null;
    o.namedItem = (n) => o.find((x) => x.id === n || x.getAttribute('name') === n) || null;
    o.add = (opt, before) => this.add(opt, before);
    o.remove = (i) => this.remove(i);
    Object.defineProperty(o, 'selectedIndex', { get: () => this.selectedIndex, set: (v) => { this.selectedIndex = v; } });
    return o;
  }
  get length() { return this.options.length; }
  set length(n) { const o = this.options; while (o.length > n) o.pop().remove(); }
  _selectedOption() {
    const opts = this.querySelectorAll('option');
    const explicit = opts.filter((o) => o._sel === true);
    if (explicit.length) return explicit[explicit.length - 1];
    const attr = opts.filter((o) => o._sel === undefined && o.hasAttribute('selected'));
    if (attr.length) return attr[attr.length - 1];
    if (this.multiple) return null;
    return opts.find((o) => o._sel !== false && !o.disabled) || opts.find((o) => !o.disabled) || null;
  }
  get selectedOptions() { const o = this._selectedOption(); return o ? [o] : []; }
  get selectedIndex() { const o = this._selectedOption(); return o ? this.options.indexOf(o) : -1; }
  set selectedIndex(i) { const opts = this.options; opts.forEach((o, k) => { o._sel = k === Number(i); }); }
  get value() { const o = this._selectedOption(); return o ? o.value : ''; }
  set value(v) {
    const opts = this.options;
    const hit = opts.find((o) => o.value === String(v));
    opts.forEach((o) => { o._sel = o === hit; });
  }
  add(opt, before) {
    if (before == null) this.appendChild(opt);
    else if (typeof before === 'number') { const r = this.options[before]; r ? r.parentNode.insertBefore(opt, r) : this.appendChild(opt); }
    else before.parentNode.insertBefore(opt, before);
  }
  remove(i) {
    if (arguments.length === 0) return super.remove();
    const o = this.options[i];
    if (o) o.remove();
  }
  item(i) { return this.options[i] || null; }
  namedItem(n) { return this.options.namedItem(n); }
  showPicker() {}
  _validityState() { const v = super._validityState(); if (this.required && this.value === '') v.valueMissing = true; return v; }
}
export class HTMLFormElement extends HTMLElement {
  constructor(doc, name, ns) {
    super(doc, name, ns);
    return new Proxy(this, {
      get(t, p, r) {
        if (typeof p === 'string' && !(p in t) && p !== 'then') {
          const el = t.elements.namedItem(p);
          if (el) return el;
        }
        return Reflect.get(t, p, r);
      },
    });
  }
  get elements() { return controlsOf(this); }
  get length() { return this.elements.length; }
  reset() {
    const ok = this.dispatchEvent(new Event('reset', { bubbles: true, cancelable: true }));
    if (!ok) return;
    for (const c of this.elements) {
      if (c.localName === 'input' || c.localName === 'textarea') { c._value = undefined; if (c._checked !== undefined) c._checked = undefined; c._bad = false; }
      if (c.localName === 'select') for (const o of c.options) o._sel = undefined;
    }
  }
  checkValidity() { return this.elements.every((c) => !c.checkValidity || c.checkValidity()); }
  reportValidity() { let ok = true; for (const c of this.elements) if (c.reportValidity && !c.reportValidity()) ok = false; return ok; }
  requestSubmit(submitter) {
    const novalidate = this.hasAttribute('novalidate') || (submitter && submitter.hasAttribute && submitter.hasAttribute('formnovalidate'));
    if (!novalidate) {
      const bad = this.elements.filter((c) => c.willValidate && c.validity && !c.validity.valid);
      if (bad.length) {
        for (const c of bad) {
          const ok = c.dispatchEvent(new Event('invalid', { cancelable: true }));
          if (ok) this.ownerDocument._nativeReports.push({ el: c, message: c.validationMessage });
        }
        return;
      }
    }
    const ok = this.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: submitter || null }));
    if (ok) this.submit();
  }
  submit() { this.ownerDocument._navigations.push('form submission of ' + (this.id ? '#' + this.id : 'a form') + ' was not prevented: the page would navigate away'); }
}

const TAG_CLASSES = {
  div: HTMLDivElement, span: HTMLSpanElement, p: HTMLParagraphElement, h1: HTMLHeadingElement, h2: HTMLHeadingElement, h3: HTMLHeadingElement,
  h4: HTMLHeadingElement, h5: HTMLHeadingElement, h6: HTMLHeadingElement, ul: HTMLUListElement, ol: HTMLOListElement, li: HTMLLIElement,
  table: HTMLTableElement, tr: HTMLTableRowElement, td: HTMLTableCellElement, th: HTMLTableCellElement, thead: HTMLTableSectionElement,
  tbody: HTMLTableSectionElement, tfoot: HTMLTableSectionElement, a: HTMLAnchorElement, img: HTMLImageElement, script: HTMLScriptElement,
  style: HTMLStyleElement, link: HTMLLinkElement, body: HTMLBodyElement, html: HTMLHtmlElement, head: HTMLHeadElement,
  input: HTMLInputElement, textarea: HTMLTextAreaElement, button: HTMLButtonElement, select: HTMLSelectElement, option: HTMLOptionElement,
  optgroup: HTMLOptGroupElement, form: HTMLFormElement, label: HTMLLabelElement, fieldset: HTMLFieldSetElement, legend: HTMLLegendElement,
  output: HTMLOutputElement, template: HTMLTemplateElement, dialog: HTMLDialogElement, canvas: HTMLCanvasElement,
};

// ---------------------------------------------------------------- document

export class Document extends Node {
  constructor() {
    super(null);
    this.ownerDocument = null;
    this.readyState = 'loading';
    this.defaultView = null;
    this._active = null;
    this._nativeReports = [];
    this._navigations = [];
    this.cookie = '';
    this.hidden = false;
    this.visibilityState = 'visible';
    this.referrer = '';
    this.characterSet = 'UTF-8';
    this.contentType = 'text/html';
    this.compatMode = 'CSS1Compat';
  }
  get nodeType() { return 9; }
  get nodeName() { return '#document'; }
  get documentElement() { return this.children.find((e) => e.localName === 'html') || this.children[0] || null; }
  get head() { const h = this.documentElement; return h ? h.children.find((e) => e.localName === 'head') || null : null; }
  get body() { const h = this.documentElement; return h ? h.children.find((e) => e.localName === 'body') || null : null; }
  get activeElement() { return this._active && this._active.isConnected ? this._active : this.body; }
  get title() { const t = this.querySelector('title'); return t ? t.textContent.trim() : ''; }
  set title(v) { let t = this.querySelector('title'); if (!t && this.head) { t = this.createElement('title'); this.head.appendChild(t); } if (t) t.textContent = v; }
  get forms() { return this.querySelectorAll('form'); }
  get scripts() { return this.querySelectorAll('script'); }
  get styleSheets() { return []; }
  get location() { return this.defaultView ? this.defaultView.location : null; }
  get URL() { return this.location ? this.location.href : 'about:blank'; }
  get documentURI() { return this.URL; }
  get baseURI() { return this.URL; }
  _handlerHost() { return this; }
  createElement(name) { return this.createElementNS(HTML_NS, String(name).toLowerCase()); }
  createElementNS(ns, qname) {
    const name = String(qname).replace(/^\w+:/, '');
    if (ns === HTML_NS || ns == null) {
      const C = TAG_CLASSES[name.toLowerCase()] || HTMLElement;
      return new C(this, name, HTML_NS);
    }
    return new SVGElement(this, name, ns);
  }
  createTextNode(t) { return new Text(this, t); }
  createComment(t) { return new Comment(this, t); }
  createDocumentFragment() { return new DocumentFragment(this); }
  createEvent() { return new Event(''); }
  createRange() {
    const doc = this;
    return { selectNodeContents() {}, setStart() {}, setEnd() {}, collapse() {}, createContextualFragment(html) { const f = doc.createDocumentFragment(); parseHTMLInto(doc, html, f); return f; }, getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; } };
  }
  createTreeWalker(root, whatToShow = 0xffffffff, filter = null) {
    const nodes = [];
    const walk = (n) => { for (const c of n.childNodes) { const ok = (c.nodeType === 1 && whatToShow & 1) || (c.nodeType === 3 && whatToShow & 4) || (c.nodeType === 8 && whatToShow & 128); if (ok && (!filter || (typeof filter === 'function' ? filter(c) : filter.acceptNode(c)) === 1)) nodes.push(c); walk(c); } };
    walk(root);
    let i = -1;
    return { root, get currentNode() { return nodes[i] || root; }, nextNode() { i++; return nodes[i] || null; }, previousNode() { i--; return nodes[i] || null; } };
  }
  importNode(n, deep) { return n.cloneNode(deep); }
  adoptNode(n) { n.remove(); return n; }
  getElementById(id) { return this.querySelectorAll('*').find((e) => e.id === id) || null; }
  getElementsByName(n) { return this.querySelectorAll('*').filter((e) => e.getAttribute('name') === n); }
  hasFocus() { return true; }
  execCommand() { return false; }
  getSelection() { return this.defaultView ? this.defaultView.getSelection() : null; }
  elementFromPoint() { return null; }
  open() { return this; }
  close() {}
  write(html) { if (this.body) this.body.insertAdjacentHTML('beforeend', html); }
}
export class NodeFilter {}
Object.assign(NodeFilter, { SHOW_ALL: 0xffffffff, SHOW_ELEMENT: 1, SHOW_TEXT: 4, SHOW_COMMENT: 128, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 });

// ---------------------------------------------------------------- HTML parser

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', times: '\u00d7', minus: '\u2212', ndash: '\u2013', mdash: '\u2014',
  hellip: '\u2026', middot: '\u00b7', copy: '\u00a9', reg: '\u00ae', deg: '\u00b0', plusmn: '\u00b1', larr: '\u2190', rarr: '\u2192',
  uarr: '\u2191', darr: '\u2193', harr: '\u2194', bull: '\u2022', thinsp: '\u2009', ensp: '\u2002', emsp: '\u2003', laquo: '\u00ab',
  raquo: '\u00bb', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', check: '\u2713', cross: '\u2717', divide: '\u00f7',
  frac12: '\u00bd', sect: '\u00a7', para: '\u00b6', trade: '\u2122', euro: '\u20ac', le: '\u2264', ge: '\u2265', ne: '\u2260', hyphen: '\u2010',
};
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    const v = ENTITIES[e.toLowerCase()] ?? ENTITIES[e];
    return v === undefined ? m : v;
  });
}
const AUTO_CLOSE = {
  li: ['li'], option: ['option'], optgroup: ['optgroup', 'option'], tr: ['tr', 'td', 'th'], td: ['td', 'th'], th: ['td', 'th'],
  dt: ['dt', 'dd'], dd: ['dt', 'dd'], thead: ['tbody', 'tfoot'], tbody: ['thead', 'tbody', 'tfoot'], tfoot: ['thead', 'tbody'],
};
const SCOPE_STOP = { li: ['ul', 'ol', 'menu'], option: ['select', 'datalist'], optgroup: ['select'], tr: ['table'], td: ['tr', 'table'], th: ['tr', 'table'], dt: ['dl'], dd: ['dl'] };
const CLOSES_P = new Set(['address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul']);

export function parseHTMLInto(doc, html, root) {
  const stack = [root];
  const cur = () => stack[stack.length - 1];
  const target = (n) => (n.localName === 'template' ? n.content : n);
  let i = 0;
  const n = html.length;
  const appendText = (t) => { if (t) target(cur()).appendChild(doc.createTextNode(t)); };
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { appendText(decodeEntities(html.slice(i))); break; }
    if (lt > i) appendText(decodeEntities(html.slice(i, lt)));
    i = lt;
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      const data = html.slice(i + 4, end < 0 ? n : end);
      target(cur()).appendChild(doc.createComment(data));
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (html[i + 1] === '!' || html[i + 1] === '?') { const end = html.indexOf('>', i); i = end < 0 ? n : end + 1; continue; }
    if (html[i + 1] === '/') {
      const m = /^<\/\s*([a-zA-Z][\w:-]*)[^>]*>/.exec(html.slice(i));
      if (!m) { appendText('<'); i++; continue; }
      const name = m[1].toLowerCase();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].localName.toLowerCase() === name) { stack.length = k; break; }
      }
      i += m[0].length;
      continue;
    }
    const m = /^<([a-zA-Z][\w:-]*)/.exec(html.slice(i));
    if (!m) { appendText('<'); i++; continue; }
    let j = i + m[0].length;
    const attrs = [];
    let selfClose = false;
    while (j < n) {
      while (j < n && /\s/.test(html[j])) j++;
      if (html[j] === '>') { j++; break; }
      if (html[j] === '/' && html[j + 1] === '>') { selfClose = true; j += 2; break; }
      if (html[j] === '/') { j++; continue; }
      const am = /^[^\s/>=]+/.exec(html.slice(j));
      if (!am) { j++; continue; }
      const aname = am[0];
      j += aname.length;
      while (j < n && /\s/.test(html[j])) j++;
      let value = '';
      if (html[j] === '=') {
        j++;
        while (j < n && /\s/.test(html[j])) j++;
        const q = html[j];
        if (q === '"' || q === "'") {
          const end = html.indexOf(q, j + 1);
          value = html.slice(j + 1, end < 0 ? n : end);
          j = end < 0 ? n : end + 1;
        } else {
          const vm = /^[^\s>]*/.exec(html.slice(j));
          value = vm[0];
          j += value.length;
        }
      }
      attrs.push([aname, decodeEntities(value)]);
    }
    i = j;
    const rawName = m[1];
    const name = rawName.toLowerCase();
    const parent = cur();
    const inForeign = parent.namespaceURI === SVG_NS || name === 'svg';
    if (!inForeign) {
      if (AUTO_CLOSE[name]) {
        for (let k = stack.length - 1; k > 0; k--) {
          const ln = stack[k].localName;
          if ((SCOPE_STOP[name] || []).includes(ln)) break;
          if (AUTO_CLOSE[name].includes(ln)) { stack.length = k; break; }
        }
      }
      if (CLOSES_P.has(name)) {
        for (let k = stack.length - 1; k > 0; k--) {
          const ln = stack[k].localName;
          if (ln === 'p') { stack.length = k; break; }
          if (!['span', 'b', 'i', 'em', 'strong', 'small', 'a', 'label', 'code'].includes(ln)) break;
        }
      }
    }
    const el = inForeign ? doc.createElementNS(SVG_NS, rawName) : doc.createElement(name);
    for (const [k, v] of attrs) el._attrs.set(inForeign ? k : k.toLowerCase(), v);
    target(cur()).appendChild(el);
    if (!inForeign && VOID.has(name)) continue;
    if (selfClose && inForeign) continue;
    if (!inForeign && (RAW.has(name) || RCDATA.has(name))) {
      const re = new RegExp(`</${name}\\s*>`, 'i');
      const rest = html.slice(i);
      const em = re.exec(rest);
      const content = em ? rest.slice(0, em.index) : rest;
      if (content) el.appendChild(doc.createTextNode(RCDATA.has(name) ? decodeEntities(content) : content));
      i += em ? em.index + em[0].length : rest.length;
      continue;
    }
    stack.push(el);
  }
}

export function parseDocument(html) {
  const doc = new Document();
  parseHTMLInto(doc, html, doc);
  let root = doc.documentElement;
  if (!root || root.localName !== 'html') {
    const h = doc.createElement('html');
    for (const c of doc.childNodes.slice()) if (c.nodeType !== 8) h.appendChild(c);
    doc.appendChild(h);
    root = h;
  }
  let head = root.children.find((e) => e.localName === 'head');
  let body = root.children.find((e) => e.localName === 'body');
  if (!head) { head = doc.createElement('head'); root.insertBefore(head, root.firstChild); }
  if (!body) {
    body = doc.createElement('body');
    for (const c of root.childNodes.slice()) {
      if (c === head) continue;
      if (c.nodeType === 1 && ['meta', 'link', 'title', 'base'].includes(c.localName)) head.appendChild(c);
      else if (c.nodeType === 1 || (c.nodeType === 3 && c.data.trim())) body.appendChild(c);
    }
    root.appendChild(body);
  }
  return doc;
}

function escText(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\u00a0/g, '&nbsp;'); }
function escAttr(s) { return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\u00a0/g, '&nbsp;'); }
export function serialize(n) {
  if (n.nodeType === 3) return n.parentNode && RAW.has(n.parentNode.localName) ? n.data : escText(n.data);
  if (n.nodeType === 8) return `<!--${n.data}-->`;
  if (n.nodeType === 11 || n.nodeType === 9) return n.childNodes.map(serialize).join('');
  const name = n.localName;
  const attrs = [...n._attrs].map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('');
  if (n.namespaceURI === HTML_NS && VOID.has(name)) return `<${name}${attrs}>`;
  const kids = (name === 'template' ? n.content.childNodes : n.childNodes).map(serialize).join('');
  return `<${name}${attrs}>${kids}</${name}>`;
}

export { LABELABLE };
