// CSS selector parsing and matching for the check DOM and the style cascade.

const cache = new Map();

function unescape(s) { return s.replace(/\\([0-9a-f]{1,6}\s?|.)/gi, (_, c) => (/^[0-9a-f]+\s?$/i.test(c) && c.trim().length > 1 ? String.fromCodePoint(parseInt(c, 16)) : c.trim() || c)); }

// Splits on top-level commas.
function splitTop(s, sep = ',') {
  const out = [];
  let depth = 0; let quote = null; let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') { cur += ch + (s[i + 1] || ''); i++; continue; }
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter((x) => x !== '');
}

const IDENT = /^-?(?:[_a-zA-Z -￿]|\\.)(?:[-\w -￿]|\\.)*/;

function parseCompound(s, pos) {
  const c = { tag: null, id: null, classes: [], attrs: [], pseudos: [], pseudoElement: false };
  let i = pos;
  const rest = () => s.slice(i);
  if (s[i] === '*') { c.tag = '*'; i++; } else {
    const m = IDENT.exec(rest());
    if (m) { c.tag = unescape(m[0]).toLowerCase(); i += m[0].length; }
  }
  for (;;) {
    const ch = s[i];
    if (ch === '#') { const m = IDENT.exec(s.slice(i + 1)) || /^[\w-]+/.exec(s.slice(i + 1)); if (!m) throw new SyntaxError('bad selector ' + s); c.id = unescape(m[0]); i += 1 + m[0].length; continue; }
    if (ch === '.') { const m = IDENT.exec(s.slice(i + 1)); if (!m) throw new SyntaxError('bad selector ' + s); c.classes.push(unescape(m[0])); i += 1 + m[0].length; continue; }
    if (ch === '[') {
      let depth = 0; let j = i; let quote = null;
      for (; j < s.length; j++) {
        const d = s[j];
        if (quote) { if (d === quote) quote = null; continue; }
        if (d === '"' || d === "'") { quote = d; continue; }
        if (d === '[') depth++;
        if (d === ']') { depth--; if (depth === 0) break; }
      }
      const body = s.slice(i + 1, j).trim();
      const am = /^([^\s~|^$*!=]+)\s*(?:([~|^$*]?=)\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s\]]+)\s*([iIsS])?)?$/.exec(body);
      if (!am) throw new SyntaxError('bad attribute selector ' + body);
      let value = am[3];
      if (value && (value[0] === '"' || value[0] === "'")) value = value.slice(1, -1);
      c.attrs.push({ name: unescape(am[1]).toLowerCase(), op: am[2] || null, value: value === undefined ? null : unescape(value), i: (am[4] || '').toLowerCase() === 'i' });
      i = j + 1;
      continue;
    }
    if (ch === ':') {
      const isEl = s[i + 1] === ':';
      i += isEl ? 2 : 1;
      const m = /^[-\w]+/.exec(s.slice(i));
      if (!m) throw new SyntaxError('bad pseudo ' + s);
      const name = m[0].toLowerCase();
      i += m[0].length;
      let arg = null;
      if (s[i] === '(') {
        let depth = 0; let j = i;
        for (; j < s.length; j++) { if (s[j] === '(') depth++; if (s[j] === ')') { depth--; if (depth === 0) break; } }
        arg = s.slice(i + 1, j).trim();
        i = j + 1;
      }
      if (isEl || ['before', 'after', 'first-line', 'first-letter', 'placeholder', 'marker', 'selection', 'backdrop', 'file-selector-button'].includes(name) || name.startsWith('-webkit-') || name.startsWith('-moz-')) {
        c.pseudoElement = true;
      } else {
        const p = { name, arg };
        if (['not', 'is', 'where', 'matches', 'any', '-webkit-any'].includes(name)) p.list = parseSelectorList(arg || '');
        if (name === 'has') p.list = parseSelectorList((arg || '').replace(/^\s*([>+~])/, ':scope $1'));
        if (/^nth-/.test(name)) p.nth = parseNth(arg || '');
        c.pseudos.push(p);
      }
      continue;
    }
    break;
  }
  if (i === pos) throw new SyntaxError('bad selector at ' + s.slice(pos));
  return { compound: c, end: i };
}

function parseNth(arg) {
  const [main, of] = arg.split(/\s+of\s+/i);
  const a0 = main.replace(/\s+/g, '').toLowerCase();
  let a = 0; let b = 0;
  if (a0 === 'odd') { a = 2; b = 1; } else if (a0 === 'even') { a = 2; b = 0; } else {
    const m = /^([-+]?\d*)n([-+]\d+)?$/.exec(a0);
    if (m) { a = m[1] === '' || m[1] === '+' ? 1 : m[1] === '-' ? -1 : Number(m[1]); b = m[2] ? Number(m[2]) : 0; } else b = Number(a0);
  }
  return { a, b, of: of ? parseSelectorList(of) : null };
}

function parseComplex(s) {
  const parts = [];
  let i = 0;
  let comb = null;
  s = s.trim();
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) { i++; if (comb === null && parts.length) comb = ' '; }
    if (i >= s.length) break;
    if ('>+~'.includes(s[i])) { comb = s[i]; i++; continue; }
    const { compound, end } = parseCompound(s, i);
    parts.push({ compound, comb: parts.length ? comb || ' ' : null });
    comb = null;
    i = end;
  }
  return parts;
}

export function parseSelectorList(s) {
  return splitTop(String(s)).map(parseComplex);
}

export function parseSelector(s) {
  s = String(s);
  let v = cache.get(s);
  if (!v) { v = parseSelectorList(s); if (!v.length) throw new SyntaxError('empty selector'); cache.set(s, v); }
  return v;
}

function siblingsOf(el) { return el.parentNode ? el.parentNode.childNodes.filter((n) => n.nodeType === 1) : [el]; }

function attrMatch(el, a) {
  const raw = el.getAttribute(a.name);
  if (raw === null) return false;
  if (a.op === null) return true;
  let v = raw; let w = a.value;
  if (a.i) { v = v.toLowerCase(); w = w.toLowerCase(); }
  switch (a.op) {
    case '=': return v === w;
    case '~=': return v.split(/\s+/).includes(w);
    case '|=': return v === w || v.startsWith(w + '-');
    case '^=': return w !== '' && v.startsWith(w);
    case '$=': return w !== '' && v.endsWith(w);
    case '*=': return w !== '' && v.includes(w);
    default: return false;
  }
}

function nthMatch(index, { a, b }) {
  if (a === 0) return index === b;
  const n = (index - b) / a;
  return Number.isInteger(n) && n >= 0;
}

function pseudoMatch(el, p, scope) {
  const doc = el.ownerDocument;
  switch (p.name) {
    case 'not': return !p.list.some((c) => matchComplex(el, c, c.length - 1, scope));
    case 'is': case 'where': case 'matches': case 'any': case '-webkit-any': return p.list.some((c) => matchComplex(el, c, c.length - 1, scope));
    case 'has': return p.list.some((c) => el.querySelectorAll('*').some((d) => matchComplex(d, c, c.length - 1, el)));
    case 'scope': return scope ? el === scope : el === doc.documentElement;
    case 'root': return el === doc.documentElement;
    case 'first-child': return siblingsOf(el)[0] === el;
    case 'last-child': { const s = siblingsOf(el); return s[s.length - 1] === el; }
    case 'only-child': return siblingsOf(el).length === 1;
    case 'first-of-type': return siblingsOf(el).find((x) => x.localName === el.localName) === el;
    case 'last-of-type': { const s = siblingsOf(el).filter((x) => x.localName === el.localName); return s[s.length - 1] === el; }
    case 'only-of-type': return siblingsOf(el).filter((x) => x.localName === el.localName).length === 1;
    case 'nth-child': case 'nth-last-child': {
      let s = siblingsOf(el);
      if (p.nth.of) s = s.filter((x) => p.nth.of.some((c) => matchComplex(x, c, c.length - 1, scope)));
      if (p.name === 'nth-last-child') s = s.slice().reverse();
      const i = s.indexOf(el);
      return i >= 0 && nthMatch(i + 1, p.nth);
    }
    case 'nth-of-type': case 'nth-last-of-type': {
      let s = siblingsOf(el).filter((x) => x.localName === el.localName);
      if (p.name === 'nth-last-of-type') s = s.slice().reverse();
      return nthMatch(s.indexOf(el) + 1, p.nth);
    }
    case 'empty': return !el.childNodes.some((n) => n.nodeType === 1 || (n.nodeType === 3 && n.data.length));
    case 'checked': return el.localName === 'option' ? el.selected : (el.localName === 'input' && ['checkbox', 'radio'].includes(el.type) && el.checked);
    case 'disabled': return ['input', 'button', 'select', 'textarea', 'option', 'fieldset'].includes(el.localName) && el.hasAttribute('disabled');
    case 'enabled': return ['input', 'button', 'select', 'textarea', 'option', 'fieldset'].includes(el.localName) && !el.hasAttribute('disabled');
    case 'required': return el.hasAttribute('required');
    case 'optional': return ['input', 'select', 'textarea'].includes(el.localName) && !el.hasAttribute('required');
    case 'read-only': return el.hasAttribute('readonly');
    case 'read-write': return ['input', 'textarea'].includes(el.localName) && !el.hasAttribute('readonly');
    case 'placeholder-shown': return el.hasAttribute('placeholder') && el.value === '';
    case 'invalid': return !!el.validity && el.willValidate && !el.validity.valid;
    case 'valid': return !!el.validity && (!el.willValidate || el.validity.valid);
    case 'user-invalid': return false;
    case 'focus': return doc._active === el;
    case 'focus-within': return !!doc._active && el.contains(doc._active);
    case 'link': case 'any-link': return (el.localName === 'a' || el.localName === 'area') && el.hasAttribute('href');
    case 'defined': return true;
    case 'lang': return (el.closest('[lang]')?.getAttribute('lang') || '').toLowerCase().startsWith((p.arg || '').toLowerCase());
    case 'open': return el.hasAttribute('open');
    default: return false; // :hover, :active, :focus-visible, :visited, :target and others never match
  }
}

function matchCompound(el, c, scope) {
  if (el.nodeType !== 1) return false;
  if (c.pseudoElement) return false;
  if (c.tag && c.tag !== '*' && el.localName.toLowerCase() !== c.tag) return false;
  if (c.id !== null && el.id !== c.id) return false;
  if (c.classes.length) { const cl = (el.getAttribute('class') || '').split(/\s+/); for (const k of c.classes) if (!cl.includes(k)) return false; }
  for (const a of c.attrs) if (!attrMatch(el, a)) return false;
  for (const p of c.pseudos) if (!pseudoMatch(el, p, scope)) return false;
  return true;
}

function matchComplex(el, parts, idx, scope) {
  if (!matchCompound(el, parts[idx].compound, scope)) return false;
  if (idx === 0) return true;
  const comb = parts[idx].comb;
  if (comb === '>') { const p = el.parentNode; return !!p && p.nodeType === 1 && matchComplex(p, parts, idx - 1, scope); }
  if (comb === ' ') { for (let p = el.parentNode; p && p.nodeType === 1; p = p.parentNode) if (matchComplex(p, parts, idx - 1, scope)) return true; return false; }
  if (comb === '+') { const p = el.previousElementSibling; return !!p && matchComplex(p, parts, idx - 1, scope); }
  if (comb === '~') { for (let p = el.previousElementSibling; p; p = p.previousElementSibling) if (matchComplex(p, parts, idx - 1, scope)) return true; return false; }
  return false;
}

export function matchesSelector(el, list, scope = null) {
  return list.some((parts) => matchComplex(el, parts, parts.length - 1, scope));
}

export function querySelectorAll(root, list) {
  const out = [];
  const scope = root.nodeType === 1 ? root : null;
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType !== 1) continue;
      if (matchesSelector(c, list, scope)) out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}

export function specificity(parts) {
  let a = 0; let b = 0; let c = 0;
  const add = (comp) => {
    if (comp.id !== null) a++;
    b += comp.classes.length + comp.attrs.length;
    if (comp.tag && comp.tag !== '*') c++;
    for (const p of comp.pseudos) {
      if (p.name === 'where') continue;
      if (['not', 'is', 'matches', 'has', 'any'].includes(p.name)) {
        const best = p.list.map(specificity).sort((x, y) => cmpSpec(y, x))[0] || [0, 0, 0];
        a += best[0]; b += best[1]; c += best[2];
      } else b++;
    }
  };
  for (const p of parts) add(p.compound);
  return [a, b, c];
}
export function cmpSpec(x, y) { return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; }
