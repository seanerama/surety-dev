// A small CSS cascade: parses the page's stylesheets and computes, for an
// element and a medium (screen or print), the declared value of a property.
// Enough to tell what is displayed on screen and in print and which colours
// and borders apply.

import { parseSelectorList, matchesSelector, specificity, cmpSpec } from './selectors.mjs';
import { parseDeclarations } from './dom.mjs';

const SCREEN = { type: 'screen', width: 1280, height: 800 };
const PRINT = { type: 'print', width: 794, height: 1123 };
export const MEDIA = { screen: SCREEN, print: PRINT };

function stripComments(s) { return s.replace(/\/\*[\s\S]*?\*\//g, ''); }

function lengthPx(v) {
  const m = /^(-?[\d.]+)(px|em|rem|in|cm|mm|pt)?$/.exec(v.trim());
  if (!m) return NaN;
  const n = Number(m[1]);
  return n * ({ px: 1, em: 16, rem: 16, in: 96, cm: 37.8, mm: 3.78, pt: 1.333 }[m[2] || 'px']);
}

function featureMatch(f, media) {
  const m = /^\(\s*([-\w]+)\s*(?::\s*([^)]*))?\)$/.exec(f.trim());
  if (!m) {
    const r = /^\(\s*([-\w]+)\s*(<=|>=|<|>)\s*([^)]*)\)$/.exec(f.trim());
    if (r && r[1] === 'width') {
      const v = lengthPx(r[3]);
      return { '<=': media.width <= v, '>=': media.width >= v, '<': media.width < v, '>': media.width > v }[r[2]];
    }
    return false;
  }
  const [, name, val = ''] = m;
  const v = val.trim();
  switch (name) {
    case 'min-width': return media.width >= lengthPx(v);
    case 'max-width': return media.width <= lengthPx(v);
    case 'min-height': return media.height >= lengthPx(v);
    case 'max-height': return media.height <= lengthPx(v);
    case 'orientation': return v === (media.width >= media.height ? 'landscape' : 'portrait');
    case 'color': return media.type === 'screen';
    case 'monochrome': return false;
    case 'hover': return v === '' || v === 'hover' ? media.type === 'screen' : v === 'none' && media.type === 'print';
    case 'pointer': return v === 'fine' ? media.type === 'screen' : v === 'none' && media.type === 'print';
    case 'prefers-color-scheme': return v === 'light';
    case 'prefers-reduced-motion': return v === 'no-preference';
    case 'prefers-contrast': return v === 'no-preference';
    case 'forced-colors': return v === 'none';
    case 'scripting': return v === 'enabled';
    default: return false;
  }
}

export function mediaMatches(query, media) {
  const q = String(query || '').trim();
  if (q === '') return true;
  return q.split(',').some((part) => {
    let p = part.trim().toLowerCase();
    let negate = false;
    if (p.startsWith('not ')) { negate = true; p = p.slice(4).trim(); }
    if (p.startsWith('only ')) p = p.slice(5).trim();
    const tokens = p.split(/\s+and\s+/);
    let ok = true;
    for (const t of tokens) {
      if (t.startsWith('(')) ok = ok && featureMatch(t, media);
      else if (t === 'all') ok = ok && true;
      else ok = ok && t === media.type;
    }
    return negate ? !ok : ok;
  });
}

function findBlockEnd(s, open) {
  let depth = 0; let quote = null;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (quote) { if (ch === '\\') { i++; continue; } if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}') { depth--; if (depth === 0) return i; }
  }
  return s.length;
}

// Returns rules: { selector, list, spec, decls, media: [queries], order }
export function parseCSS(text, baseMedia = []) {
  const rules = [];
  const walk = (s, media) => {
    let i = 0;
    while (i < s.length) {
      while (i < s.length && /[\s;]/.test(s[i])) i++;
      if (i >= s.length) break;
      if (s[i] === '}') { i++; continue; }
      const brace = s.indexOf('{', i);
      const semi = s.indexOf(';', i);
      if (s[i] === '@' && (semi >= 0 && (brace < 0 || semi < brace))) { i = semi + 1; continue; }
      if (brace < 0) break;
      const prelude = s.slice(i, brace).trim();
      const end = findBlockEnd(s, brace);
      const body = s.slice(brace + 1, end);
      i = end + 1;
      if (prelude.startsWith('@')) {
        const m = /^@([-\w]+)\s*(.*)$/s.exec(prelude);
        const name = m ? m[1].toLowerCase() : '';
        if (name === 'media') walk(body, [...media, m[2]]);
        else if (name === 'supports' || name === 'layer' || name === 'container' || name === 'scope' || name === 'document') walk(body, media);
        continue;
      }
      let list;
      try { list = parseSelectorList(prelude); } catch { continue; }
      const nestedAt = body.indexOf('{');
      const declText = nestedAt >= 0 ? body.slice(0, body.lastIndexOf(';', nestedAt) + 1) : body;
      const decls = parseDeclarations(declText);
      list.forEach((parts, k) => {
        rules.push({ selector: prelude, list: [parts], spec: specificity(parts), decls, media, order: 0, sub: k });
      });
    }
  };
  walk(stripComments(text), baseMedia);
  return rules;
}

const UA_CSS = `
[hidden]:not([hidden=until-found]), area, base, datalist, head, link, meta, noscript, script, style, template, title { display: none }
input[type=hidden] { display: none }
dialog:not([open]) { display: none }
html, body, div, section, main, header, footer, nav, article, aside, form, fieldset, ul, ol, li, p, h1, h2, h3, h4, h5, h6, table, tr, td, th { display: block }
`;
const UA_RULES = parseCSS(UA_CSS);

const SHORTHAND_PARTS = {
  background: ['background-color', 'background-image'],
  border: ['border-top', 'border-right', 'border-bottom', 'border-left'],
  'border-color': ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'],
  'border-style': ['border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style'],
  'border-width': ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'],
  'border-inline': ['border-left', 'border-right'],
  'border-block': ['border-top', 'border-bottom'],
  'border-inline-start': ['border-left'], 'border-inline-end': ['border-right'],
  'border-block-start': ['border-top'], 'border-block-end': ['border-bottom'],
  outline: ['outline'],
};

export class StyleEngine {
  // sheets: [{ text, media }] in document order
  constructor(sheets) {
    this.rules = [];
    let order = 0;
    for (const r of UA_RULES) this.rules.push({ ...r, origin: 0, order: order++ });
    for (const sh of sheets) for (const r of parseCSS(sh.text, sh.media ? [sh.media] : [])) this.rules.push({ ...r, origin: 1, order: order++ });
    this.cache = new Map();
  }
  reset() { this.cache = new Map(); }
  // All declarations that apply to el in a medium, winner per property.
  declared(el, mediaName) {
    const key = mediaName;
    let perEl = this.cache.get(el);
    if (!perEl) { perEl = {}; this.cache.set(el, perEl); }
    if (perEl[key]) return perEl[key];
    const media = MEDIA[mediaName];
    const cands = [];
    for (const r of this.rules) {
      if (!r.media.every((q) => mediaMatches(q, media))) continue;
      if (!matchesSelector(el, r.list)) continue;
      for (const d of r.decls) cands.push({ ...d, origin: r.origin, spec: r.spec, order: r.order });
    }
    const inline = parseDeclarations(el.getAttribute('style') || '');
    inline.forEach((d, k) => cands.push({ ...d, origin: 2, spec: [1, 0, 0, 0], order: 1e9 + k }));
    // A presentational hidden attribute is the UA's; author rules may override it.
    const rank = (d) => (d.important ? (d.origin === 0 ? 5 : 4) : (d.origin === 2 ? 3 : d.origin));
    cands.sort((a, b) => rank(a) - rank(b) || (a.origin === 2 || b.origin === 2 ? a.order - b.order : cmpSpec(a.spec, b.spec) || a.order - b.order));
    const out = new Map();
    for (const d of cands) {
      out.set(d.prop, d.value);
      const parts = SHORTHAND_PARTS[d.prop];
      if (parts) for (const p of parts) out.set(p, d.value);
    }
    perEl[key] = out;
    return out;
  }
  // Resolves var() using custom properties inherited along the ancestors.
  custom(el, name, mediaName, depth = 0) {
    for (let n = el; n && n.nodeType === 1; n = n.parentNode) {
      const v = this.declared(n, mediaName).get(name);
      if (v !== undefined) return depth > 10 ? v : this.resolve(n, v, mediaName, depth + 1);
    }
    return undefined;
  }
  resolve(el, value, mediaName, depth = 0) {
    if (value == null) return value;
    let v = String(value);
    for (let k = 0; k < 10 && v.includes('var('); k++) {
      v = v.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g, (_, name, fb) => {
        const got = this.custom(el, name, mediaName, depth);
        return got !== undefined ? got : (fb ?? '');
      });
    }
    return v.trim();
  }
  value(el, prop, mediaName) {
    const v = this.declared(el, mediaName).get(prop);
    return v === undefined ? undefined : this.resolve(el, v, mediaName);
  }
  display(el, mediaName) {
    const v = this.value(el, 'display', mediaName);
    if (v === undefined) return 'inline';
    const t = v.toLowerCase();
    if (t === 'inherit') return el.parentElement ? this.display(el.parentElement, mediaName) : 'inline';
    return t;
  }
  // Displayed and not hidden by visibility, for el and all its ancestors.
  visible(el, mediaName) {
    let vis = null;
    for (let n = el; n && n.nodeType === 1; n = n.parentNode) {
      if (this.display(n, mediaName) === 'none') return false;
      if (vis === null) {
        const v = this.value(n, 'visibility', mediaName);
        if (v && v !== 'inherit') vis = v.toLowerCase();
      }
      if (this.value(n, 'content-visibility', mediaName) === 'hidden' && n !== el) return false;
    }
    return vis === null || vis === 'visible';
  }
}

// ---------------------------------------------------------------- colours

const GREY_NAMES = new Set(['black', 'white', 'gray', 'grey', 'silver', 'gainsboro', 'dimgray', 'dimgrey', 'darkgray', 'darkgrey', 'lightgray', 'lightgrey', 'whitesmoke', 'transparent', 'currentcolor', 'canvas', 'canvastext', 'buttonface', 'buttontext', 'graytext', 'windowtext', 'window']);
const CHROMATIC_NAMES = new Set(('aliceblue antiquewhite aqua aquamarine azure beige bisque blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgreen darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dodgerblue firebrick floralwhite forestgreen fuchsia ghostwhite gold goldenrod green greenyellow honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgreen lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat yellow yellowgreen highlight accentcolor linktext visitedtext activetext mark').split(' '));

function chromaticRGB(r, g, b, a = 1) {
  if (a === 0) return false;
  return Math.max(r, g, b) - Math.min(r, g, b) > 12;
}
function num(x, scale = 255) { x = x.trim(); return x.endsWith('%') ? (parseFloat(x) / 100) * scale : parseFloat(x); }

// The chromatic colours a declared value names (empty when it is all grey).
export function chromaticColours(value) {
  const found = [];
  if (!value) return found;
  const v = String(value).toLowerCase();
  for (const m of v.matchAll(/#([0-9a-f]{3,8})\b/g)) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16); const g = parseInt(h.slice(2, 4), 16); const b = parseInt(h.slice(4, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    if (chromaticRGB(r, g, b, a)) found.push(m[0]);
  }
  for (const m of v.matchAll(/rgba?\(([^)]*)\)/g)) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    const [r, g, b] = parts.slice(0, 3).map((p) => num(p));
    const a = parts[3] !== undefined ? num(parts[3], 1) : 1;
    if (chromaticRGB(r, g, b, a)) found.push(m[0]);
  }
  for (const m of v.matchAll(/hsla?\(([^)]*)\)/g)) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    const s = parseFloat(parts[1]);
    const l = parseFloat(parts[2]);
    const a = parts[3] !== undefined ? num(parts[3], 1) : 1;
    if (s > 5 && l > 2 && l < 98 && a !== 0) found.push(m[0]);
  }
  for (const m of v.matchAll(/(?:oklch|lch)\(([^)]*)\)/g)) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    if (parseFloat(parts[1]) > 0.02 * (m[0].startsWith('ok') ? 1 : 100)) found.push(m[0]);
  }
  for (const m of v.matchAll(/(?:oklab|lab)\(([^)]*)\)/g)) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    if (Math.abs(parseFloat(parts[1])) + Math.abs(parseFloat(parts[2])) > (m[0].startsWith('ok') ? 0.02 : 2)) found.push(m[0]);
  }
  const words = v.replace(/[a-z-]+\([^)]*\)/g, ' ').match(/[a-z]+/g) || [];
  for (const w of words) if (CHROMATIC_NAMES.has(w) && !GREY_NAMES.has(w)) found.push(w);
  return found;
}
