// The engine's table of a design tree's mockups (D7 §5.2, §5.4, §5.7;
// SEAM.md §§499 to 501): each mockup's target and preview capability as the
// engine computes them from its own facts, never as the Designer declares
// them. "Simulations are labelled by the engine, not the role."
//
// - The path is the mockup's path normalised; one that is absolute, climbs
//   out of the tree or names no file of it is left out (nothing is served
//   there).
// - The target is what the mockup says it simulates, else its first
//   screen's target, and only if the approved module map has that UI
//   target; otherwise it is unknown.
// - The capability is `previewCapability(target, technology,
//   design_preview)` from the module map's technology for the target, and
//   never `native` for an HTML mockup that is not `static_html` or
//   `scene_html` or that declares a simulation. Unknown with an unknown
//   target.
// The preview's server frames every HTML path the table does not list as
// native, so whatever is unknown here is shown as a simulation.

import { posix } from 'node:path';

import { type PreviewCapability, previewCapability } from './inventory.js';
import { MOCKUPS_VARIABLE, type ServedMockup, type Simulates, isHtmlPath } from './preview/server.mjs';

export interface Unknown {
  unknown: string;
}

export interface EngineMockup {
  path: string;
  kind: string;
  target: string | Unknown;
  capability: PreviewCapability | Unknown;
  // What the frame's banner says, for a mockup that is not native HTML.
  simulates: Simulates | null;
}

const unknown = (why: string): Unknown => ({ unknown: why });
const isUnknown = (v: unknown): v is Unknown => v !== null && typeof v === 'object' && 'unknown' in v;
const obj = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const parse = (b: Buffer | undefined): unknown => {
  if (b === undefined) return undefined;
  try {
    return JSON.parse(b.toString('utf8'));
  } catch {
    return undefined;
  }
};
const NATIVE_HTML_KINDS = ['static_html', 'scene_html'];

export function engineMockups(
  files: Map<string, Buffer>,
  facts: { targets: { target: string; technology: string }[]; design_preview: string },
): { mockups: EngineMockup[]; unread: Unknown | null } {
  const design = obj(parse(files.get('design.json')));
  if (design === null) return { mockups: [], unread: unknown('design.json is missing or does not parse: no mockup could be read') };
  const screens = obj(parse(files.get('screens.json')))?.screens;
  const targetOfScreen = new Map<string, string>();
  for (const s of Array.isArray(screens) ? screens : []) {
    const o = obj(s);
    if (o && typeof o.key === 'string' && typeof o.target === 'string') targetOfScreen.set(o.key, o.target);
  }
  const technology = new Map(facts.targets.map((t) => [t.target, t.technology]));
  const out: EngineMockup[] = [];
  const seen = new Set<string>();
  for (const m0 of Array.isArray(design.mockups) ? design.mockups : []) {
    const m = obj(m0);
    if (!m || typeof m.path !== 'string' || m.path === '') continue;
    const path = posix.normalize(m.path);
    if (path.startsWith('/') || path === '..' || path.startsWith('../') || !files.has(path) || seen.has(path)) continue;
    seen.add(path);
    const kind = typeof m.kind === 'string' ? m.kind : '';
    const sim = obj(m.simulates);
    const keys = Array.isArray(m.screens) ? m.screens.filter((k): k is string => typeof k === 'string') : [];
    const claimed = typeof sim?.target === 'string' ? sim.target : keys.map((k) => targetOfScreen.get(k)).find((t) => t !== undefined);
    const target: string | Unknown =
      claimed === undefined ? unknown('no screen of the mockup names a target') : technology.has(claimed) ? claimed : unknown(`${claimed} is not a UI target of the approved module map`);
    let capability: PreviewCapability | Unknown;
    if (isUnknown(target)) capability = unknown('the mockup\'s target is unknown');
    else {
      const c = previewCapability(target, technology.get(target)!, facts.design_preview);
      capability = c === 'native' && isHtmlPath(path) && (!NATIVE_HTML_KINDS.includes(kind) || sim !== null) ? 'simulated' : c;
    }
    const nativeHtml = capability === 'native';
    const simulates: Simulates | null =
      isHtmlPath(path) && !nativeHtml
        ? {
            target: isUnknown(target) ? 'a target the engine could not determine' : target,
            ...(typeof sim?.form_factor === 'string' && sim.form_factor !== '' ? { form_factor: sim.form_factor } : {}),
            layout: typeof sim?.layout === 'string' && sim.layout !== '' ? sim.layout : 'layout not declared',
          }
        : null;
    out.push({ path, kind, target, capability, simulates });
  }
  return { mockups: out, unread: null };
}

// The table as the configuration's environment carries it to the server.
export function servedTable(table: { mockups: EngineMockup[]; unread: Unknown | null }): Record<string, string> {
  const mockups: ServedMockup[] = table.mockups.map((m) => ({
    path: m.path,
    target: isUnknown(m.target) ? null : m.target,
    capability: isUnknown(m.capability) ? null : m.capability,
    simulates: m.simulates,
  }));
  return { [MOCKUPS_VARIABLE]: JSON.stringify({ mockups, ...(table.unread ? { note: `No mockup is listed: ${table.unread.unknown}. Every HTML file is shown as a simulation.` } : {}) }) };
}

// SIMULATIONS.txt (SEAM.md §501): one line per mockup the preview frames
// (an HTML mockup the engine does not hold native),
// `<path>\t<target>\t<form_factor or ->\t<layout>`, after free-text lines
// beginning `#`.
export function simulationsText(table: { mockups: EngineMockup[]; unread: Unknown | null }): string {
  const lines = [
    '# Written by the Surety engine (D7 §5.7). Each line names a mockup that is a simulation:',
    '# an HTML drawing of a screen of a target this preview cannot run natively. It is not',
    '# native behaviour: back, safe areas, permissions, gestures, window chrome and menus are',
    '# drawn, not exercised. Columns: path, target, form factor (- if none), layout.',
    ...(table.unread ? [`# ${table.unread.unknown}; every HTML file of this tree is to be taken as a simulation.`] : []),
    '',
  ];
  for (const m of table.mockups) if (m.simulates) lines.push([m.path, m.simulates.target, m.simulates.form_factor ?? '-', m.simulates.layout].map((x) => x.replace(/[\t\r\n]/g, ' ')).join('\t'));
  return `${lines.join('\n')}\n`;
}
