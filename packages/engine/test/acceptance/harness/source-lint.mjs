// Source inspection for the seam-confinement rule (SEAM.md §7 "Confinement",
// row M74). It reads TypeScript source as text: a small lexer removes comments
// and separates words, string, template and regular-expression literals, and
// three checks run over the tokens. No compiler API is used, so what it can
// see is lexical; SEAM.md says what that does and does not prove.
//
// Paths are POSIX and relative to packages/engine/src/.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

export const SEAM_FOLDER = 'testing';
export const SEAM_MODULE = 'testing/seam.ts';
// What a production file writes to import the seam module (module: nodenext).
const SEAM_IMPORT_TARGET = 'testing/seam.js';
export const CLI_ENTRY = 'cli.ts';

// The names SEAM.md fixes for what a client can observe of harness mode.
const HARNESS_NAMES = /harness|test_fixture/i;

// A `/` after one of these words starts a regular expression, not a division.
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

// Tokens: {kind, text, line}. kind is 'word' (identifier or keyword), 'number',
// 'string' (text is the content between the quotes, escapes left as written),
// 'template' (one token per literal chunk of a template), 'regex' (the body)
// or 'punct'. Comments and whitespace produce nothing.
export function tokenize(text, file = '<source>') {
  const tokens = [];
  const n = text.length;
  let i = 0;
  let line = 1;
  const fail = (what, at) => {
    throw new Error(`${file}:${at}: ${what}`);
  };
  const push = (kind, value, at) => tokens.push({ kind, text: value, line: at });
  const regexAllowed = () => {
    const prev = tokens.at(-1);
    if (!prev) return true;
    if (prev.kind === 'punct') return ![')', ']', '}'].includes(prev.text);
    if (prev.kind === 'word') return REGEX_AFTER_WORD.has(prev.text);
    return false;
  };

  function string(quote) {
    const at = line;
    let value = '';
    i++;
    for (;;) {
      if (i >= n || text[i] === '\n') fail('unterminated string', at);
      const c = text[i];
      if (c === '\\') {
        if (text[i + 1] === '\n') line++;
        value += text.slice(i, i + 2);
        i += 2;
      } else if (c === quote) {
        i++;
        break;
      } else {
        value += c;
        i++;
      }
    }
    push('string', value, at);
  }

  function template() {
    const at = line;
    let chunk = '';
    let chunkLine = line;
    i++;
    for (;;) {
      if (i >= n) fail('unterminated template', at);
      const c = text[i];
      if (c === '\\') {
        if (text[i + 1] === '\n') line++;
        chunk += text.slice(i, i + 2);
        i += 2;
      } else if (c === '`') {
        if (chunk !== '') push('template', chunk, chunkLine);
        i++;
        return;
      } else if (c === '$' && text[i + 1] === '{') {
        if (chunk !== '') push('template', chunk, chunkLine);
        i += 2;
        code(true);
        chunk = '';
        chunkLine = line;
      } else {
        if (c === '\n') line++;
        chunk += c;
        i++;
      }
    }
  }

  // A `/` where a regular expression may start. If no closing `/` follows on
  // the same line it was a division after all (`i++ / 2`), and nothing is consumed.
  function regex() {
    let body = '';
    let inClass = false;
    let j = i + 1;
    for (;;) {
      if (j >= n || text[j] === '\n') return false;
      const c = text[j];
      if (c === '\\') {
        body += text.slice(j, j + 2);
        j += 2;
        continue;
      }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) {
        j++;
        break;
      }
      body += c;
      j++;
    }
    while (j < n && /[a-z]/.test(text[j])) j++;
    push('regex', body, line);
    i = j;
    return true;
  }

  // Code up to the end of the text or, inside a template, up to the `}` that
  // closes the `${`.
  function code(inTemplate) {
    const at = line;
    let depth = 0;
    while (i < n) {
      const c = text[i];
      if (c === '\n') {
        line++;
        i++;
      } else if (/\s/.test(c)) {
        i++;
      } else if (c === '/' && text[i + 1] === '/') {
        while (i < n && text[i] !== '\n') i++;
      } else if (c === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2);
        if (end < 0) fail('unterminated comment', line);
        for (let k = i; k < end; k++) if (text[k] === '\n') line++;
        i = end + 2;
      } else if (c === '"' || c === "'") {
        string(c);
      } else if (c === '`') {
        template();
      } else if (/[A-Za-z_$]/.test(c)) {
        let j = i + 1;
        while (j < n && /[A-Za-z0-9_$]/.test(text[j])) j++;
        push('word', text.slice(i, j), line);
        i = j;
      } else if (/[0-9]/.test(c)) {
        let j = i + 1;
        while (j < n && (/[A-Za-z0-9_]/.test(text[j]) || (text[j] === '.' && /[0-9]/.test(text[j + 1] ?? '')))) j++;
        push('number', text.slice(i, j), line);
        i = j;
      } else if (c === '/' && regexAllowed() && regex()) {
        // consumed as a regular expression
      } else if (c === '}' && inTemplate && depth === 0) {
        i++;
        return;
      } else {
        if (c === '{') depth++;
        if (c === '}') depth--;
        let p = c;
        if (text.startsWith('...', i)) p = '...';
        else if (c === '?' && text[i + 1] === '.' && !/[0-9]/.test(text[i + 2] ?? '')) p = '?.';
        push('punct', p, line);
        i += p.length;
      }
    }
    if (inTemplate) fail('unterminated template expression', at);
  }

  code(false);
  return tokens;
}

const isWord = (t, text) => t?.kind === 'word' && (text === undefined || t.text === text);
const isPunct = (t, text) => t?.kind === 'punct' && t.text === text;

// Every place a file names another module: static imports with their
// bindings, `export … from`, and `import()` / `require()` of a literal.
// Each is {kind, spec (token index of the specifier), start, end, bindings}.
export function moduleRefs(tokens) {
  const refs = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.kind !== 'word' || isPunct(tokens[k - 1], '.') || isPunct(tokens[k - 1], '?.')) continue;

    if (t.text === 'require' || t.text === 'import') {
      if (isPunct(tokens[k + 1], '(')) {
        const arg = tokens[k + 2];
        if (arg && (arg.kind === 'string' || arg.kind === 'template')) refs.push({ kind: 'dynamic', spec: k + 2, start: k, end: k + 2, bindings: [] });
        continue;
      }
      if (t.text === 'require') continue;
    }

    if (t.text === 'import') {
      if (isPunct(tokens[k + 1], '.')) continue; // import.meta
      if (tokens[k + 1]?.kind === 'string') {
        refs.push({ kind: 'import', spec: k + 1, start: k, end: k + 1, bindings: [] });
        continue;
      }
      let j = k + 1;
      let typeOnly = false;
      if (isWord(tokens[j], 'type') && !isWord(tokens[j + 1], 'from') && !isPunct(tokens[j + 1], ',')) {
        typeOnly = true;
        j++;
      }
      const bindings = [];
      let ok = true;
      while (ok && j < tokens.length && !isWord(tokens[j], 'from')) {
        const c = tokens[j];
        if (isPunct(c, ',')) {
          j++;
        } else if (isPunct(c, '*') && isWord(tokens[j + 1], 'as') && isWord(tokens[j + 2])) {
          bindings.push({ local: tokens[j + 2].text, namespace: true, typeOnly });
          j += 3;
        } else if (isPunct(c, '{')) {
          j++;
          while (j < tokens.length && !isPunct(tokens[j], '}')) {
            if (isPunct(tokens[j], ',')) {
              j++;
              continue;
            }
            let specType = false;
            if (isWord(tokens[j], 'type') && isWord(tokens[j + 1]) && !isWord(tokens[j + 1], 'as')) {
              specType = true;
              j++;
            }
            if (!isWord(tokens[j])) {
              ok = false;
              break;
            }
            let local = tokens[j].text;
            j++;
            if (isWord(tokens[j], 'as') && isWord(tokens[j + 1])) {
              local = tokens[j + 1].text;
              j += 2;
            }
            bindings.push({ local, namespace: false, typeOnly: typeOnly || specType });
          }
          j++;
        } else if (c.kind === 'word') {
          bindings.push({ local: c.text, namespace: false, typeOnly });
          j++;
        } else {
          ok = false;
        }
      }
      if (ok && isWord(tokens[j], 'from') && tokens[j + 1]?.kind === 'string') {
        refs.push({ kind: 'import', spec: j + 1, start: k, end: j + 1, bindings });
        k = j + 1;
      }
      continue;
    }

    if (t.text === 'export') {
      let j = k + 1;
      if (isWord(tokens[j], 'type')) j++;
      if (isPunct(tokens[j], '*')) {
        j++;
        if (isWord(tokens[j], 'as') && isWord(tokens[j + 1])) j += 2;
      } else if (isPunct(tokens[j], '{')) {
        while (j < tokens.length && !isPunct(tokens[j], '}')) j++;
        j++;
      } else {
        continue;
      }
      if (isWord(tokens[j], 'from') && tokens[j + 1]?.kind === 'string') {
        refs.push({ kind: 'export-from', spec: j + 1, start: k, end: j + 1, bindings: [] });
        k = j + 1;
      }
    }
  }
  return refs;
}

// Where a literal written in `file` points, as a path under src/, if it is a
// relative path; null otherwise.
const resolveFrom = (file, literal) => (literal.startsWith('.') ? posix.normalize(posix.join(posix.dirname(file), literal)) : null);

const inSeamFolder = (path) => path === SEAM_FOLDER || path.startsWith(`${SEAM_FOLDER}/`);

// Does this literal, written in `file`, name a path inside the seam folder?
function namesSeamFolder(file, literal) {
  const resolved = resolveFrom(file, literal);
  if (resolved !== null) return inSeamFolder(resolved);
  return new RegExp(`(^|/)${SEAM_FOLDER}/`).test(literal);
}

const quote = (t) => (t.kind === 'string' ? `'${t.text}'` : t.kind === 'template' ? `\`${t.text}\`` : t.kind === 'regex' ? `/${t.text}/` : t.text);

// The three checks of SEAM.md §7 "Confinement" over a set of sources
// [{file, text}]. Returns {door, callOnly, names}, each a list of
// {file, line, what}. Files inside the seam folder are not inspected.
export function inspectSources(sources) {
  const door = [];
  const callOnly = [];
  const names = [];

  for (const { file, text } of sources) {
    if (inSeamFolder(file)) continue;
    const tokens = tokenize(text, file);
    const refs = moduleRefs(tokens);
    const refBySpec = new Map(refs.map((r) => [r.spec, r]));
    const inDeclaration = (index) => refs.some((r) => index >= r.start && index <= r.end);

    // 1. One door.
    const seamImports = [];
    tokens.forEach((t, index) => {
      if ((t.kind !== 'string' && t.kind !== 'template') || !namesSeamFolder(file, t.text)) return;
      const ref = refBySpec.get(index);
      const target = resolveFrom(file, t.text);
      if (ref?.kind === 'import' && target === SEAM_IMPORT_TARGET) {
        seamImports.push(ref);
        return;
      }
      const how =
        ref?.kind === 'import'
          ? 'imports a module of the seam folder other than the seam module'
          : ref?.kind === 'export-from'
            ? 're-exports from the seam folder'
            : ref?.kind === 'dynamic'
              ? 'loads a module of the seam folder dynamically'
              : 'names a path inside the seam folder';
      door.push({ file, line: t.line, what: `${how}: ${quote(t)}` });
    });

    // 2. Call only.
    for (const ref of seamImports) {
      for (const binding of ref.bindings) {
        if (binding.typeOnly) continue;
        tokens.forEach((t, index) => {
          if (t.kind !== 'word' || t.text !== binding.local || inDeclaration(index)) return;
          const prev = tokens[index - 1];
          const next = tokens[index + 1];
          if (isPunct(prev, '.') || isPunct(prev, '?.')) return; // a property of something else
          if (isPunct(next, ':') && (isPunct(prev, '{') || isPunct(prev, ',') || isPunct(prev, '('))) return; // a key or a parameter
          const called = binding.namespace
            ? isPunct(next, '.') && isWord(tokens[index + 2]) && isPunct(tokens[index + 3], '(')
            : isPunct(next, '(');
          if (!called) callOnly.push({ file, line: t.line, what: `uses the seam export "${binding.local}" without calling it` });
        });
      }
    }

    // 3. No harness names.
    for (const t of tokens) {
      if (!['word', 'string', 'template', 'regex'].includes(t.kind) || !HARNESS_NAMES.test(t.text)) continue;
      if (file === CLI_ENTRY && !/test_fixture/i.test(t.text)) {
        if (t.kind === 'word') continue;
        const onlyFlags = t.kind !== 'regex' && [...t.text.matchAll(/harness/gi)].every((m) => t.text.slice(Math.max(0, m.index - 2), m.index) === '--');
        if (onlyFlags) continue;
      }
      const kind = t.kind === 'word' ? 'identifier' : t.kind === 'regex' ? 'regular expression' : t.kind;
      const named = /test_fixture/i.test(t.text) ? 'the fixture label' : 'the harness';
      names.push({ file, line: t.line, what: `${kind} ${quote(t)} names ${named} outside the seam folder` });
    }
  }
  return { door, callOnly, names };
}

// Every .ts file under a source directory, as [{file, text}] sorted by path.
export function readSources(srcDir) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(path).isDirectory()) walk(path, rel);
      else if (name.endsWith('.ts')) out.push({ file: rel, text: readFileSync(path, 'utf8') });
    }
  };
  walk(srcDir, '');
  return out;
}

export const formatViolations = (list) => list.map((v) => `  packages/engine/src/${v.file}:${v.line}: ${v.what}`).join('\n');
