// TPL §11's change log row, written by the engine (D6 §3.4, §4.5; the
// coordinator's ruling on slice 34's question 2, as refined): approval's
// effect writes the row of the version it approves, `| Version | Date |
// Change | Approved by |`, into §11 of the approved text (replacing a row of
// that version, else appended), in one journaled engine commit. §11 is outside the semantic
// representation (B.2), so the digest is unchanged. Pure: text in, text out.
//
// Nothing of a role's or the owner's text enters the row: the change is the
// engine's own words (a version, a request's number), so nothing typed is
// interpreted here or later.

export interface ChangeLogRow {
  version: number;
  date: string;
  change: string;
  approved_by: string;
}

const cell = (s: string): string => s.replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|').trim();

export function changeLogLine(r: ChangeLogRow): string {
  return `| ${r.version} | ${cell(r.date)} | ${cell(r.change)} | ${cell(r.approved_by)} |`;
}

const HEADER = ['| Version | Date | Change | Approved by |', '|---|---|---|---|'];
const H2 = /^##\s+(\d+)\.\s/;

// A table row's cells, a `\|` inside a cell being part of it (the
// review's N1: the engine reads its own rows back).
const cellsOf = (line: string): string[] | null => {
  const t = line.trim();
  if (!t.startsWith('|') || !t.endsWith('|') || t.length < 2 || t.endsWith('\\|')) return null;
  return t.slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim());
};

// The table of a §11 section that parses: its header `| Version | Date |
// Change | Approved by |`, its separator, and its rows' line numbers; null
// when the section holds no such table.
function tableOf(lines: string[], start: number, end: number): { rows: number[]; last: number } | null {
  let i = start + 1;
  while (i < end && cellsOf(lines[i]!) === null) i++;
  if (i >= end) return null;
  const header = cellsOf(lines[i]!)!.map((c) => c.toLowerCase());
  if (header.length !== 4 || header.join('|') !== 'version|date|change|approved by') return null;
  const sep = i + 1 < end ? cellsOf(lines[i + 1]!) : null;
  if (sep === null || sep.length !== 4 || sep.some((c) => !/^:?-{3,}:?$/.test(c))) return null;
  const rows: number[] = [];
  let j = i + 2;
  for (; j < end; j++) {
    const c = cellsOf(lines[j]!);
    if (c === null) break;
    if (c.length !== 4) return null;
    rows.push(j);
  }
  return { rows, last: j - 1 };
}

// The text with the engine's row for `row.version` in §11 (the
// coordinator's refinement of ruling 2): the engine owns the row of the
// version it approves, so a row of §11 whose Version cell is that version
// (a template's or a Spec Writer's placeholder) is replaced by it, else it
// is appended after the last row; rows of other versions are left alone.
// When no §11 holds a table that parses, a new §11 with the table is
// appended at the end of the file: an approval never fails on §11.
// `text` is the file's bytes one character each (latin1), so that what lies
// outside the row is written back byte for byte (the review's N7); the row
// takes the line ending of the table it joins.
export function appendChangeLog(text: string, row: ChangeLogRow): string {
  const bare = changeLogLine(row);
  const lines = text.split('\n');
  const crlf = lines.length > 1 && lines[0]!.endsWith('\r');
  let chosen: { start: number; table: { rows: number[]; last: number } } | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (H2.exec(lines[i]!)?.[1] !== '11') continue;
    let end = lines.length;
    for (let k = i + 1; k < lines.length; k++) {
      if (H2.test(lines[k]!)) {
        end = k;
        break;
      }
    }
    const table = tableOf(lines, i, end);
    if (table) chosen = { start: i, table };
  }
  if (chosen === null) {
    const eol = crlf ? '\r\n' : '\n';
    const body = text.endsWith('\n') ? text : `${text}${eol}`;
    return `${body}${eol}${['## 11. Change log', '', ...HEADER, bare, ''].join(eol)}`;
  }
  const line = lines[chosen.table.last]!.endsWith('\r') ? `${bare}\r` : bare;
  const own = chosen.table.rows.filter((n) => cellsOf(lines[n]!)![0] === String(row.version));
  if (own.length > 0) {
    const out = [...lines];
    out[own[0]!] = line;
    // One row per version: any further row of the same version goes.
    for (const n of own.slice(1).reverse()) out.splice(n, 1);
    return out.join('\n');
  }
  return [...lines.slice(0, chosen.table.last + 1), line, ...lines.slice(chosen.table.last + 1)].join('\n');
}
