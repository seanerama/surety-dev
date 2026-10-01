#!/usr/bin/env node
// D1 body <-> Appendix A consistency checker (lexical, both directions).
// Usage: node scripts/d1-consistency.mjs [path-to-D1.md]
// Exit 0 when clean, 1 when any finding is reported, 2 on a structural error.
//
// Rules (B17):
//  R1  every enum/type, reason code, event, error code, config key, table or field the body
//      references in backticks is declared in Appendix A;
//  R2  every enum value, reason code, error code, event, decision kind and config key declared
//      in A is referenced by the body, by A.3/A.5/A.8, or is marked reserved;
//  R3  every state named in an A.5 transition table is a value of the enum the table names;
//  R4  every A.8 decision kind is in A.2 DecisionKind and vice versa;
//  R5  every foreign key in A.3 names a declared table.
// Enum-value matching is case-insensitive and treats "_", "-" and " " as equivalent so that
// prose such as "post-deploy identity" owns `post_deploy_identity`.

import { readFileSync } from 'node:fs';

const path = process.argv[2] ?? 'sdlc-design-D1-engine-core.md';
const text = readFileSync(path, 'utf8');
const idx = text.indexOf('\n## Appendix A.');
if (idx < 0) { console.error('Appendix A not found'); process.exit(2); }
const body = text.slice(0, idx);
const appx = text.slice(idx);
const section = (name) => {
  const m = appx.match(new RegExp(`\\n### ${name.replace('.', '\\.')}[^\\n]*\\n([\\s\\S]*?)(?=\\n### A\\.|$)`));
  return m ? m[1] : '';
};
const findings = new Set();
const norm = (s) => s.toLowerCase().replace(/[-_ ]+/g, '_');
const bodyNorm = norm(body);
const mentions = (hay, v) => new RegExp(`(^|[^a-z0-9])${norm(v).replace(/_/g, '[_ -]')}(?=$|[^a-z0-9])`, 'i').test(hay);

// ---------- declarations ----------
const tables = new Set(), fields = new Map(), enums = new Map(), reasons = new Set(),
  errors = new Set(), events = new Set(), decisionKinds = new Set(), config = new Set();
for (const m of section('A.1').matchAll(/`[a-z]+_`\s*\|\s*([a-z_]+)/g)) tables.add(m[1]);
for (const m of section('A.2').matchAll(/\*\*([A-Za-z]+):\*\*\s*([^*\n]*)/g)) {
  const vals = m[2].replace(/the values in A\.6\.?/, '').split(/[,.]\s*/).map(s => s.trim()).filter(s => /^[a-z][a-z0-9_]*$|^T[123]$/.test(s));
  enums.set(m[1], new Set(vals));
}
for (const line of section('A.3').split('\n')) {
  const t = line.match(/^- \*\*([a-z_]+):\*\*\s*(.*)$/); if (!t) continue;
  tables.add(t[1]);
  const fs = new Set();
  for (const f of t[2].matchAll(/`([a-z0-9_]+)[^`]*`/g)) fs.add(f[1]);
  // nested object keys inside {...} shapes, innermost first
  let rest = t[2];
  for (let guard = 0; guard < 8; guard++) {
    const g = [...rest.matchAll(/\{([^{}]*)\}/g)];
    if (!g.length) break;
    for (const m of g) for (const k of m[1].matchAll(/(?:^|[\s,])([a-z0-9_]+)(?=[\s,=:?\[\]{}→]|$)/g)) fs.add(k[1]);
    rest = rest.replace(/\{[^{}]*\}/g, '');
  }
  fields.set(t[1], fs);
}
// A.10 projection-only fields (not persisted)
const projection = new Set(); for (const m of section('A.10').matchAll(/`([a-z0-9_]+)`/g)) projection.add(m[1]);
for (const m of section('A.4').matchAll(/`([A-Z_]+)`/g)) reasons.add(m[1]);
for (const m of section('A.6').matchAll(/`([a-z_]+\.[a-z_]+)`/g)) events.add(m[1]);
for (const m of section('A.7').matchAll(/`([a-z_]+)`/g)) errors.add(m[1]);
for (const m of section('A.8').matchAll(/^\|\s*([a-z_, ]+)\s*\|/gm)) for (const k of m[1].split(',')) { const kk = k.trim(); if (/^[a-z_]+$/.test(kk) && kk !== 'kind') decisionKinds.add(kk); }
for (const m of section('A.9').matchAll(/`([a-z_]+)`/g)) config.add(m[1]);
const enumValues = new Set(); for (const s of enums.values()) for (const v of s) enumValues.add(v);
const fieldNames = new Set(); for (const s of fields.values()) for (const v of s) fieldNames.add(v);
const known = new Set([...tables, ...enumValues, ...fieldNames, ...reasons, ...errors, ...events, ...decisionKinds, ...config, ...enums.keys(), ...projection]);
const a358 = section('A.3') + section('A.5') + section('A.8');

// ---------- R1: body references ----------
const skipSpan = /^(surety|GET|POST|[0-9]|\$|\.surety|git |node|better-sqlite3|worker_thread|SURETY_|Sec-Fetch|Origin|Referer|Host|Content-Length|X-|no-store|Surety-|\/|--|evaluateGate|invoke|endRun|session\.|applyProtectedProposal|records\.write|scripts\/|engine\/|packages\/|checkpoint: true|synchronous=|\.git|incomplete_for_recovery|\{|\[|\(|r-|c-|op-|d-|F-|pv-|p-|w-|UNIQUE|503|restricted|full|hash\(|sha256\(|\[\.surety|GIT_|GH_|https?:|import|null|open|closed|\.\.)/;
const stop = new Set(['and','or','the','not','null','true','false','bool','int','sha','oid','json','id','ids','per','only','any','with','where','is','to','of','on','in','by','at','a','an','as','for','one','two','all','no','sum','key','row','rows','fact','facts','name','file','path','ref','refs','tree','index','head','probe','then','else','iff','via','new','old','seq','list','set','opt','arg','args','env','cwd','pid','pgid','uid','gc','csrf','cors','sse','api','cli','ui','url','ssh','aws','npm','tsc','mjs','md','ws','git','worktree','detach','add','commit','update','write','diff','reset','stash','keep','cand','oob','checks','spec','adrs','architecture','roadmap','phases','policy','project','records','workspaces','backups','engine','store','lock','token','log','db','value','values','read','reads','writes','blob','message','normalized','sorted','category','check','finding','snapshot_tree','kind','where','is','null']);
for (const m of body.matchAll(/`([^`\n]+)`/g)) {
  const span = m[1];
  if (skipSpan.test(span)) continue;
  if (/\.(token|lock|log|db|json|mjs|md|html)$/.test(span)) continue; // file names, not events
  if (/^[a-z_]+\.[a-z_]+$/.test(span)) { if (!events.has(span)) findings.add(`R1 body references event \`${span}\` not declared in A.6`); continue; }
  for (const p of span.split(/[\s,():*?]+/).filter(Boolean)) {
    if (stop.has(p)) continue;
    if (/^[A-Z][A-Za-z]+$/.test(p)) { if (!enums.has(p) && !/^(FULL|MUST|SHOULD|D[0-9]+|A[0-9]+|B[0-9]+|N[0-9]+|E[0-9]+|O[0-9]+|Q[0-9]+|IS|NULL|WHERE|TERM|KILL)$/.test(p)) findings.add(`R1 body references type \`${p}\` not declared in A.2`); }
    else if (/^[A-Z_]{4,}$/.test(p)) { if (!reasons.has(p) && p !== 'EFFECT_PRECONDITION_CHANGED') findings.add(`R1 body references reason code \`${p}\` not declared in A.4`); }
    else if (/^[a-z_]+\.[a-z_]+$/.test(p)) { if (!events.has(p)) findings.add(`R1 body references event \`${p}\` not declared in A.6`); }
    else if (/^[a-z][a-z0-9_]+$/.test(p) && p.length > 2 && !known.has(p)) findings.add(`R1 body references \`${p}\` not declared anywhere in Appendix A`);
  }
}
// ---------- R2: unused declarations ----------
for (const [en, vals] of enums) for (const v of vals) if (!mentions(body, v) && !mentions(a358, v)) findings.add(`R2 enum ${en}.${v} has no owner in the body, A.3, A.5 or A.8`);
for (const r of reasons) if (!body.includes(r)) findings.add(`R2 reason code ${r} declared but never referenced in body`);
for (const e of errors) if (!body.includes(e) && !section('A.7').includes(`| ${e}`)) findings.add(`R2 error code ${e} declared but never referenced in body`);
for (const ev of events) if (!body.includes(ev)) findings.add(`R2 event ${ev} declared but no owning transition is named in the body`);
const dk = enums.get('DecisionKind') ?? new Set();
for (const k of decisionKinds) if (!dk.has(k)) findings.add(`R4 A.8 decision kind ${k} is not in A.2 DecisionKind`);
for (const k of dk) if (!decisionKinds.has(k)) findings.add(`R4 A.2 DecisionKind.${k} has no A.8 row`);
for (const k of config) if (!body.includes(k) && !a358.includes(k)) findings.add(`R2 config key ${k} declared but never referenced in body, A.3, A.5 or A.8`);
// ---------- R3: A.5 states ----------
const stateTables = { 'Run state': 'RunState', 'Session state': 'SessionState', 'Candidate': 'CandidateProgress', 'Attempt': 'AttemptStatus', 'Decision': 'DecisionStatus', 'Intent': 'IntentStatus', 'Finding': 'FindingStatus', 'Proposal': 'ProposalStatus', 'Assessment': 'AssessmentStatus', 'Journal': 'JournalState', 'Domain': 'DomainStatus', 'Authorization': 'AuthorizationStatus' };
const a5 = section('A.5');
for (const [label, en] of Object.entries(stateTables)) {
  const m = a5.match(new RegExp(`\\*\\*${label}\\*\\*\\s*\\(\\x60${en}\\x60\\):([^\\n]*?)(?=\\*\\*|\\n|$)`));
  if (!m) { findings.add(`R3 A.5 has no "${label}" table naming ${en}`); continue; }
  const vals = enums.get(en) ?? new Set();
  for (const s of m[1].matchAll(/\b([a-z_]+)→([a-z_]+)/g)) for (const st of [s[1], s[2]]) if (!vals.has(st) && !/^(run|finalizing)$/.test(st)) findings.add(`R3 A.5 ${label}: state ${st} not in ${en}`);
}
const wi = enums.get('WorkItemStatus') ?? new Set();
for (const row of a5.matchAll(/^\|\s*[a-z_, ]+\s*\|\s*([^|]+)\|/gm)) for (const s of row[1].matchAll(/\b([a-z_]+)→([a-z_]+)/g)) for (const st of [s[1], s[2]]) if (!wi.has(st)) findings.add(`R3 A.5 WorkItem table: state ${st} not in WorkItemStatus`);
// ---------- R5: foreign keys ----------
for (const line of section('A.3').split('\n')) { if (!line.startsWith('- **')) continue; for (const m of line.matchAll(/→([a-z_]+)/g)) if (!tables.has(m[1])) findings.add(`R5 A.3 foreign key →${m[1]} names an undeclared table`); }

const out = [...findings].sort();
console.log(`D1 consistency: ${out.length} finding(s)`);
for (const f of out) console.log(' - ' + f);
process.exit(out.length ? 1 : 0);
