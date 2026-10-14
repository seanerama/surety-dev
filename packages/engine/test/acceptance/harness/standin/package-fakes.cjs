// SURETY PACKAGE-DRIVEN REHEARSAL FAKES (M5 slice 38; row M442 (b), (c);
// BS5 §12, §4.1 rule 18; E135; SEAM.md §455).
//
// The roles of the real lane's rehearsal and of M442's kernel rehearsal, each
// a pure function of the context package it is given, the workspace it
// writes and the rehearsal's CONTENT. What the engine READS of a product
// (its form: TPL's header, B.2's forms, the index columns, the marks, the
// question form, the closed areas, the tier names, the approval blockers,
// B.3 to B.6's fields, the plan reasons' kinds, the routing, the check
// definitions' kinds, gate kinds, covers, requires, secrets, the post-deploy
// form, the authoring result's fields, the adoption rule, the Builder's
// tasks, implements, integration obligations and dependency interfaces) is
// taken ONLY from the package: its `json surety-reads <id>` blocks
// (SEAM.md §§453, 454), its result-schema.json and its facts files
// (authoring.json, phase-plan.json, interfaces/, requirements/, the replan's
// files, the approved inputs). Nothing of that form is written here: an
// element the package omits is missing from the product, and the rehearsal
// then fails where the engine reads it (M442 (b)).
//
// What the rehearsal's owner says (the project's content: its requirements,
// modules, ADRs, phases; a change request) comes from the owner's turns in
// the transcript or the change request's text, as fenced blocks
// `json rehearsal-owner`, `json rehearsal-architecture` and
// `json rehearsal-change`. What no package can say and a model would write
// (the code of a stage, the program of a check, the toolchain's governed
// file, an adopted test's copy) is the CONTENT object, keyed by what the
// package names (a path a task names, a check key the fake derived from the
// package, a criterion): see harness/real/rehearsal-content.mjs.
//
// Self-contained: Node built-ins only, CommonJS, no top-level side effect but
// the definition of SURETY_PACKAGE_FAKES (and module.exports where there is
// a module), so that it can be concatenated before rehearsal-claude.cjs into
// the rehearsal's fake binary (build-rehearsal-claude.sh) and required by the
// kernel lane's scripted role program (scripted/child.mjs, step
// `package_fake`).

var SURETY_PACKAGE_FAKES = (function () {
  'use strict';
  const fs = require('node:fs');
  const path = require('node:path');

  // ---- the package -----------------------------------------------------------------------

  function walk(dir, rel, out) {
    let names = [];
    try {
      names = fs.readdirSync(path.join(dir, rel));
    } catch {
      return out;
    }
    for (const name of names.sort()) {
      const r = rel === '' ? name : `${rel}/${name}`;
      let st;
      try {
        st = fs.lstatSync(path.join(dir, r));
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(dir, r, out);
      else if (st.isFile() && st.size <= 1 << 20) {
        try {
          out[r] = fs.readFileSync(path.join(dir, r), 'utf8');
        } catch {
          out[r] = null;
        }
      }
    }
    return out;
  }

  const BLOCK = /^```json surety-reads ([A-Za-z0-9_.]+)[ \t]*\n([\s\S]*?)^```[ \t]*$/gm;
  const parse = (t, d = null) => {
    try {
      return t === null || t === undefined ? d : JSON.parse(t);
    } catch {
      return d;
    }
  };

  function readPackage(dir) {
    const files = walk(dir, '', {});
    const prompt = files['prompt.md'] ?? '';
    const reads = {};
    for (const m of prompt.matchAll(BLOCK)) {
      const v = parse(m[2], undefined);
      if (v !== undefined) reads[m[1]] = v;
    }
    return { dir, files, prompt, reads, manifest: parse(files['manifest.json'], {}) ?? {}, resultSchema: parse(files['result-schema.json'], null), transcript: parse(files['transcript.json'], []) };
  }

  // The last fenced `json <tag>` block in a text, parsed.
  function taggedBlock(text, tag) {
    if (typeof text !== 'string') return null;
    const re = new RegExp('```json ' + tag.replace(/[.]/g, '\\.') + '[ \\t]*\\n([\\s\\S]*?)\\n```', 'g');
    let last = null;
    for (const m of text.matchAll(re)) last = parse(m[1], last);
    return last;
  }
  // What the owner said in a tagged block, latest first: the transcript's
  // owner entries, then the prompt (which quotes the owner's last words).
  function ownerSaid(pkg, tag) {
    const entries = Array.isArray(pkg.transcript) ? pkg.transcript : [];
    for (const e of [...entries].reverse()) {
      if (e && e.speaker === 'owner') {
        const b = taggedBlock(e.text, tag);
        if (b) return b;
      }
    }
    return taggedBlock(pkg.prompt, tag);
  }

  // A result with exactly the fields the package's result schema lists (and
  // status and summary, which every schema has).
  function shapeResult(pkg, values) {
    const props = pkg.resultSchema && pkg.resultSchema.properties ? pkg.resultSchema.properties : null;
    const out = { status: 'completed', summary: values.summary ?? 'rehearsal' };
    for (const [k, v] of Object.entries(values)) if (v !== undefined && (props === null ? false : k in props)) out[k] = v;
    return out;
  }

  // A JSON Schema's object pruned to what the schema declares (recursively);
  // a value of a field the schema does not have is dropped. No schema: null.
  function prune(schema, value) {
    if (!schema || typeof schema !== 'object') return value;
    if (Array.isArray(value)) return schema.items ? value.map((v) => prune(schema.items, v)) : value;
    if (value && typeof value === 'object' && schema.properties) {
      const out = {};
      for (const [k, v] of Object.entries(value)) if (k in schema.properties && v !== undefined) out[k] = prune(schema.properties[k], v);
      return out;
    }
    return value;
  }

  // The workspace's HEAD, read from its git files (no process).
  function headOf(workspace) {
    try {
      let gitDir = path.join(workspace, '.git');
      if (fs.statSync(gitDir).isFile()) {
        const m = /^gitdir:\s*(.*)$/m.exec(fs.readFileSync(gitDir, 'utf8'));
        gitDir = path.resolve(workspace, m[1].trim());
      }
      const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
      if (/^[0-9a-f]{40}$/.test(head)) return head;
      const ref = /^ref:\s*(.*)$/.exec(head)[1];
      const common = fs.existsSync(path.join(gitDir, 'commondir')) ? path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()) : gitDir;
      for (const d of [gitDir, common]) {
        try {
          return fs.readFileSync(path.join(d, ref), 'utf8').trim();
        } catch {}
        try {
          const packed = fs.readFileSync(path.join(d, 'packed-refs'), 'utf8');
          const line = packed.split('\n').find((l) => l.endsWith(` ${ref}`));
          if (line) return line.split(' ')[0];
        } catch {}
      }
    } catch {}
    return null;
  }

  function writer(workspace) {
    const written = {};
    return {
      written,
      write(rel, text) {
        const p = path.join(workspace, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, text);
        written[rel] = text;
      },
      read(rel) {
        try {
          return fs.readFileSync(path.join(workspace, rel), 'utf8');
        } catch {
          return null;
        }
      },
      list(rel) {
        try {
          return fs.readdirSync(path.join(workspace, rel)).sort();
        } catch {
          return [];
        }
      },
    };
  }

  // ---- reading an approved specification (B.2), for the Architect and the Verifier --------

  function sectionsOf(text) {
    const out = {};
    let cur = null;
    for (const line of String(text ?? '').split('\n')) {
      const m = /^## (\d+)\./.exec(line);
      if (m) {
        cur = Number(m[1]);
        out[cur] = [];
      } else if (cur !== null) out[cur].push(line);
    }
    return out;
  }
  function tableOf(lines) {
    const rows = (lines ?? []).filter((l) => l.trim().startsWith('|'));
    if (rows.length < 2) return [];
    const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const head = cells(rows[0]);
    return rows.slice(2).map((r) => Object.fromEntries(cells(r).map((c, i) => [head[i], c])));
  }
  function readSpec(text) {
    if (typeof text !== 'string') return null;
    const field = (n) => (new RegExp('^\\*\\*' + n + ':\\*\\*\\s*(.*)$', 'm').exec(text) || [])[1] || null;
    const secs = sectionsOf(text);
    const index = tableOf(secs[5]).map((r) => ({ key: r.Key, title: r.Title, phase: Number(r.Phase) || null, areas: (r['Sensitive areas'] || '').split(',').map((s) => s.trim()).filter((s) => s && s !== 'none'), criteria: (r.Criteria || '').split(',').map((s) => s.trim()).filter(Boolean) }));
    const criteriaText = {};
    for (const line of secs[4] ?? []) {
      const m = /^- (R\d+\.\d+)\s+(.*)$/.exec(line);
      if (m) criteriaText[m[1]] = m[2];
    }
    return { version: Number(field('Spec version')) || null, tier: ((field('Tier') || '').match(/T[123]/) || [null])[0], index, criteriaText, modules: tableOf(secs[6]).map((r) => ({ name: r.Module, areas: (r['Sensitive areas'] || '').split(',').map((s) => s.trim()).filter((s) => s && s !== 'none') })) };
  }
  function approvedSpec(pkg) {
    for (const [name, text] of Object.entries(pkg.files)) {
      if ((name.startsWith('approved/') || name === 'spec.md') && /^## 5\./m.test(text ?? '')) return readSpec(text);
    }
    return null;
  }

  // ---- the Spec Writer: a session turn (B.2; TPL) ----------------------------------------

  function specWriterTurn(pkg, ws) {
    const o = ownerSaid(pkg, 'rehearsal-owner');
    if (!o) return shapeResult(pkg, { summary: 'asked the owner', reply: 'Tell me the project: its requirements, modules and environments.', artifact_changed: false });
    const R = pkg.reads;
    const areaList = R['spec_writer.sensitive_areas'];
    const areaOf = (phrase) => {
      const hit = areaList && Array.isArray(areaList.areas) ? areaList.areas.find((a) => a && (a.id === phrase || a.name === phrase)) : null;
      return hit ? hit.id : phrase;
    };
    // No area: the list's word for none; without the list, the owner's own words.
    const areas = (xs) => (Array.isArray(xs) && xs.length > 0 ? xs.map(areaOf).join(', ') : areaList && areaList.none ? areaList.none : (o.no_area_words ?? 'no sensitive area'));
    const tierOf = (word) => {
      const t = R['spec_writer.tier_table'];
      const hit = t && Array.isArray(t.tiers) ? t.tiers.find((x) => x && (x.name === word || x.tier === word)) : null;
      return hit ? hit.tier : word;
    };
    const L = [`# ${o.project}`, ''];
    const header = R['spec_writer.header_fields'];
    if (header && Array.isArray(header.fields)) {
      for (const f of header.fields) {
        const n = String(f.name ?? '');
        const value = /version/i.test(n) ? String(o.spec_version ?? 1) : /status/i.test(n) ? (f.value ?? 'draft') : /tier/i.test(n) ? tierOf(o.tier) : /owner/i.test(n) ? o.owner : '';
        L.push(`${f.line} ${value}`);
      }
      L.push('');
    }
    L.push('## 1. Purpose', '', o.purpose ?? '', '', '## 2. Non-goals', '', ...(o.non_goals ?? []).map((x) => `- ${x}`), '', '## 3. Users and situations', '', o.users ?? '', '');
    const form = R['spec_writer.requirement_form'];
    L.push(form && form.section ? form.section : '## 4. Requirements', '');
    const marks = R['spec_writer.marks'];
    for (const r of o.requirements ?? []) {
      if (form) {
        L.push(String(form.heading).replace('R<n>', r.key).replace('<title>', r.title), '', r.statement, '', `**Rationale.** ${r.rationale ?? 'The owner asked for it.'}`, '', `${form.sensitive_areas} ${areas(r.areas)}`, '');
        if ((r.criteria ?? []).length > 0) {
          L.push('**Acceptance criteria**', '');
          for (const c of r.criteria) L.push(String(form.criterion).replace('R<n>.<m>', c.id).replace('<text>', c.text));
          L.push('');
        } else if (r.human_test && marks && marks.human_test) L.push(marks.human_test, '', r.human_test, '');
        else if (r.descriptive && marks && marks.descriptive) L.push(marks.descriptive, '');
        else if (r.human_test) L.push(r.human_test, '');
      } else {
        L.push(`${r.key} (${r.title}): ${r.statement}`, '');
        for (const c of r.criteria ?? []) L.push(`Criterion ${c.id}: ${c.text}`);
        L.push('');
      }
    }
    const idx = R['spec_writer.index_columns'];
    if (idx && Array.isArray(idx.columns)) {
      L.push(idx.section, '', `| ${idx.columns.join(' | ')} |`, `|${idx.columns.map(() => '---').join('|')}|`);
      for (const r of o.requirements ?? []) {
        const cell = (c) =>
          ({ Key: r.key, Title: r.title, Phase: String(r.phase ?? ''), 'Sensitive areas': areas(r.areas), Criteria: (r.criteria ?? []).map((c) => c.id).join(', '), Origin: r.origin ?? idx.default_origin ?? '' })[c] ?? '';
        L.push(`| ${idx.columns.map(cell).join(' | ')} |`);
      }
      L.push('');
    }
    const mt = R['spec_writer.module_table'];
    if (mt && Array.isArray(mt.columns)) {
      L.push(mt.section, '', `| ${mt.columns.join(' | ')} |`, `|${mt.columns.map(() => '---').join('|')}|`);
      for (const m of o.modules ?? []) L.push(`| ${mt.columns.map((c) => ({ Module: m.name, Paths: (m.paths ?? []).map((p) => `\`${p}\``).join(', '), 'Sensitive areas': areas(m.areas) })[c] ?? '').join(' | ')} |`);
      L.push('', '**Protected paths**', '', ...(o.protected_paths ?? ['.surety/checks/']).map((p) => `- \`${p}\``), '');
    }
    const ef = R['spec_writer.environment_fields'];
    if (ef && Array.isArray(ef.fields)) {
      L.push(ef.section, '');
      for (const e of o.environments ?? []) {
        L.push(String(ef.heading).replace('<name>', e.name), '');
        for (const f of ef.fields) L.push(String(ef.line ?? '- **<Field>:** <value>').replace('<Field>', f).replace('<value>', (e.fields ?? {})[f] ?? 'not stated'));
        L.push('');
      }
    }
    L.push('## 8. Constraints', '', ...(o.constraints ?? []).map((c) => `- ${c}`), '', '## 9. Interfaces and data', '', o.interfaces ?? '', '');
    const qf = R['spec_writer.question_form'];
    const blockers = R['spec_writer.approval_blockers'];
    const hinted = Boolean(blockers && Array.isArray(blockers.blockers) && blockers.blockers.some((b) => b && b.code === 'QUESTION_NO_PHASE_HINT'));
    const qs = o.questions ?? [];
    if (qf) {
      L.push(qf.section, '');
      if (qs.length === 0) L.push('None.');
      for (const q of qs) L.push(`${String(qf.item).replace('Q<k>', q.id).replace('<text>', q.text)}${hinted && qf.phase_hint ? ` ${String(qf.phase_hint).replace('<n>', q.phase)}` : ''}`);
      L.push('');
    } else if (qs.length > 0) {
      L.push('Open questions, for the owner:', '', ...qs.map((q) => `${q.text}`), '');
    }
    const ct = R['spec_writer.claims_table'];
    if (ct && Array.isArray(ct.columns) && (o.claims ?? []).length > 0) {
      L.push(ct.section, '', `| ${ct.columns.join(' | ')} |`, `|${ct.columns.map(() => '---').join('|')}|`);
      for (const c of o.claims) L.push(`| ${ct.columns.map((k) => String(({ Source: c.source, Claim: c.claim, Observed: c.observed, Requirement: c.requirement })[k] ?? '').replace(/\|/g, '\\|')).join(' | ')} |`);
      L.push('');
    }
    ws.write('.surety/spec/spec.md', L.join('\n'));
    return shapeResult(pkg, { summary: 'wrote the specification', reply: 'I wrote the specification in the form the engine reads.', artifact_changed: true, done: true });
  }

  // ---- the Architect: a session turn, and the replan one-shot (B.3 to B.6; §5.3, §5.4) ------

  const citing = (desc, key) => new RegExp(`\\b${key}\\b`).test(String(desc ?? ''));

  // The stages of phase `n`: one per requirement the phase holds, on the
  // module whose interfaces the requirement's key is cited by, chained in
  // order; tasks name each such interface's path; validation from the spec's
  // criteria, the plan reasons' kinds at the tier, and the areas.
  function stagesFor(pkg, { phase, requirements, modules, spec, adrs, obligations, base, conformance }) {
    const R = pkg.reads;
    const kinds = R['architect.plan_reasons'] && R['architect.plan_reasons'].kinds_by_tier ? (R['architect.plan_reasons'].kinds_by_tier[spec.tier] ?? []) : [];
    const crit = (k) => (spec.index.find((r) => r.key === k) || { criteria: [] }).criteria;
    const reqAreas = (k) => (spec.index.find((r) => r.key === k) || { areas: [] }).areas;
    if (conformance) {
      const mods = modules.filter((m) => requirements.some((k) => (m.interfaces ?? []).some((i) => citing(i.description, k))));
      return [{ number: base + 1, goal: `conformance of the adopted code: ${requirements.join(', ')}`, tasks: [], modules: mods.map((m) => m.name), implements: requirements, adrs, depends_on: [], validation: { criteria: requirements.flatMap(crit), kinds, sensitive_areas: [...new Set([...mods.flatMap((m) => m.sensitive_areas ?? []), ...requirements.flatMap(reqAreas)])] }, integration_obligations: [], conformance: true }];
    }
    return requirements.map((key, i) => {
      const owned = modules.filter((m) => (m.interfaces ?? []).some((f) => citing(f.description, key)));
      const ifaces = owned.flatMap((m) => (m.interfaces ?? []).filter((f) => citing(f.description, key)));
      const byPath = {};
      for (const f of ifaces) (byPath[f.path ?? f.name] ??= []).push(f.description);
      const number = base + i + 1;
      return {
        number,
        goal: `${key}: ${(spec.index.find((r) => r.key === key) || {}).title ?? key}`,
        tasks: Object.entries(byPath).map(([p, ds]) => `write \`${p}\`: ${ds.join('; ')}`),
        modules: owned.map((m) => m.name),
        implements: [key],
        adrs,
        depends_on: i === 0 ? [] : [number - 1],
        validation: { criteria: crit(key), kinds, sensitive_areas: [...new Set([...owned.flatMap((m) => m.sensitive_areas ?? []), ...reqAreas(key)])] },
        integration_obligations: owned.flatMap((m) => (obligations ?? {})[m.name] ?? []),
      };
    });
  }

  function writeArchitectFiles(pkg, ws, { arch, spec, phase, versions, revision, roadmapToo, stages, conformance }) {
    const R = pkg.reads;
    const S = (id) => (R[id] && R[id].schema ? R[id] : null);
    if (roadmapToo) {
      ws.write('.surety/architecture/architecture.md', `# Architecture\n\n${arch.architecture ?? ''}\n`);
      if (S('architect.schema.modules')) ws.write(R['architect.schema.modules'].file, `${JSON.stringify(prune(R['architect.schema.modules'].schema, { version: 1, modules: arch.modules, mapping_from_spec: arch.mapping ?? [] }), null, 2)}\n`);
      const adr = R['architect.schema.adr'];
      if (adr && adr.front_matter) {
        const props = adr.front_matter.properties ?? {};
        for (const a of arch.adrs ?? []) {
          const fm = Object.entries({ key: a.key, status: a.status, supersedes: a.supersedes, reconstructed: a.reconstructed }).filter(([k, v]) => v !== undefined && k in props);
          const body = (adr.headings ?? []).flatMap((h) => [`## ${h}`, '', a[String(h).toLowerCase()] ?? '', '']);
          ws.write(String(adr.file).replace('ADR-<nnn>', a.key), ['---', ...fm.map(([k, v]) => `${k}: ${v}`), '---', '', `# ${a.key}: ${a.title ?? ''}`, '', ...body].join('\n'));
        }
      }
      if (S('architect.schema.roadmap')) {
        ws.write('.surety/roadmap/roadmap.md', `# Roadmap\n\n${(arch.phases ?? []).map((p) => `${p.number}. ${p.goal}`).join('\n')}\n`);
        ws.write(R['architect.schema.roadmap'].file, `${JSON.stringify(prune(R['architect.schema.roadmap'].schema, { version: 1, architecture_version: 1, phases: (arch.phases ?? []).map((p) => ({ number: p.number, goal: p.goal, modules: p.modules, requirement_ids: p.requirements, depends_on: p.depends_on ?? [] })) }), null, 2)}\n`);
      }
    }
    if (S('architect.schema.phase_plan')) {
      // Routing is computed from the artifacts (§5.4): a plan that changes no
      // approved artifact is within its baseline. Told nothing of routing, a
      // careful Architect declares its plan uncertain.
      const declared = R['architect.routing'] ? 'within_baseline' : 'uncertain';
      const plan = { phase, prepared_against: { spec_version: versions.spec, architecture_version: versions.architecture, roadmap_version: versions.roadmap, revision }, stages, conformance: declared, notes: conformance ? 'the conformance phase' : undefined };
      ws.write(String(R['architect.schema.phase_plan'].file).replace('<n>', String(phase)), `${JSON.stringify(prune(R['architect.schema.phase_plan'].schema, plan), null, 2)}\n`);
      ws.write(`.surety/phases/phase-${phase}.md`, `# Phase ${phase}\n\n${stages.map((s) => `- Stage ${s.number}: ${s.goal}`).join('\n')}\n`);
      return declared;
    }
    return null;
  }

  function architectTurn(pkg, ws) {
    const arch = ownerSaid(pkg, 'rehearsal-architecture');
    const spec = approvedSpec(pkg);
    if (!arch || !spec) return shapeResult(pkg, { summary: 'asked the owner', reply: 'I need the approved specification and your architecture.', artifact_changed: false });
    const phase1 = (arch.phases ?? []).find((p) => p.number === 1);
    const stages = stagesFor(pkg, { phase: 1, requirements: phase1 ? phase1.requirements : [], modules: arch.modules ?? [], spec, adrs: (arch.adrs ?? []).map((a) => a.key), obligations: arch.obligations, base: 0, conformance: arch.conformance_phase === 1 });
    writeArchitectFiles(pkg, ws, { arch, spec, phase: 1, versions: { spec: spec.version ?? 1, architecture: 1, roadmap: 1 }, revision: headOf(ws.root), roadmapToo: true, stages, conformance: arch.conformance_phase === 1 });
    return shapeResult(pkg, { summary: 'wrote the architecture and the first plan', reply: 'The architecture, module map, ADRs, roadmap and phase 1.', artifact_changed: true, done: true });
  }

  function replanRun(pkg, ws) {
    const f = pkg.files;
    const gen = parse(f['generation.json'], {}) ?? {};
    const spec = readSpec(f['spec.md']);
    const roadmap = parse(f['roadmap.json'], null);
    const map = parse(f['module_map.json'], null);
    const done = parse(f['plan.json'], null);
    if (!spec || !roadmap || !map || !done) return shapeResult(pkg, { summary: 'the approved baseline could not be read from the package; nothing planned' });
    const phases = Array.isArray(roadmap.phases) ? roadmap.phases : Array.isArray(roadmap) ? roadmap : [];
    const next = (done.phase_number ?? 0) + 1;
    const ph = phases.find((p) => Number(p.number) === next);
    if (!ph) return shapeResult(pkg, { summary: `no phase ${next} in the roadmap` });
    const modules = Array.isArray(map.modules) ? map.modules : Array.isArray(map) ? map : [];
    const base = Math.max(0, ...(done.stages ?? []).map((s) => Number(s.number) || 0));
    const adrs = Object.keys(f).filter((n) => /^adrs\/.+\.md$/.test(n)).map((n) => path.basename(n, '.md'));
    const obligations = {};
    for (const s of done.stages ?? []) for (const m of s.modules ?? []) if (Array.isArray(s.integration_obligations) && s.integration_obligations.length > 0) obligations[m] = s.integration_obligations;
    const stages = stagesFor(pkg, { phase: next, requirements: ph.requirement_ids ?? ph.requirements ?? [], modules, spec, adrs, obligations, base, conformance: false });
    const declared = writeArchitectFiles(pkg, ws, { arch: {}, spec, phase: next, versions: { spec: gen.spec_revision?.version ?? spec.version, architecture: gen.architecture_revision?.version ?? 1, roadmap: gen.roadmap_revision?.version ?? 1 }, revision: headOf(ws.root), roadmapToo: false, stages });
    return shapeResult(pkg, { summary: `phase ${next} planned`, plan: `phase-${next}`, conformance: declared ?? 'uncertain' });
  }

  // ---- the Spec Writer's change (B.7) ------------------------------------------------------

  function specChangeRun(pkg, ws) {
    const req = parse(pkg.files['change_request.json'], {}) ?? {};
    const change = taggedBlock(req.text ?? req.request_text ?? '', 'rehearsal-change') ?? taggedBlock(pkg.prompt, 'rehearsal-change');
    let text = ws.read('.surety/spec/spec.md');
    if (!change || text === null) return shapeResult(pkg, { summary: 'the change could not be read', changes: [] });
    const changes = [];
    for (const [id, t] of Object.entries(change.criteria ?? {})) {
      text = text.replace(new RegExp(`^(- ${id.replace('.', '\\.')}) .*$`, 'm'), `$1 ${t}`);
      changes.push({ key: id.split('.')[0], kind: 'criteria_changed', reason: change.reason ?? 'the owner\'s change request' });
    }
    for (const [key, s] of Object.entries(change.statements ?? {})) {
      text = text.replace(new RegExp(`(^### ${key}\\b[^\\n]*\\n\\n)[^\\n]*`, 'm'), `$1${s}`);
      changes.push({ key, kind: 'text_changed', reason: change.reason ?? 'the owner\'s change request' });
    }
    text = text.replace(/^(\*\*Spec version:\*\*)\s*(\d+)/m, (_, a, n) => `${a} ${Number(n) + 1}`);
    ws.write('.surety/spec/spec.md', text);
    // The result's list of changes, in the form the package states it (spec_writer.change_result).
    const cr = pkg.reads['spec_writer.change_result'];
    const kinds = cr && cr.item && Array.isArray(cr.item.kind) ? cr.item.kind : [];
    const listed = cr ? changes.filter((c) => kinds.includes(c.kind)) : [];
    return shapeResult(pkg, { summary: 'the change proposed', ...(cr ? { [cr.field]: listed } : {}) });
  }

  // ---- the Verifier: phase authoring and correction (D3 Appendix B; §6.2; §8.3) ----------------

  // The governed file the first phase's authoring writes, from the
  // package's `verifier.toolchain` element alone: its file, its closed
  // members, the effective values (`current`) and the runtimes it offers;
  // the toolchain is the first runtime, read from where its path lies.
  function governedFrom(R) {
    const t = R['verifier.toolchain'];
    if (!t || !Array.isArray(t.runtimes) || t.runtimes.length === 0) return null;
    const rt = t.runtimes[0];
    const cur = t.current && typeof t.current === 'object' ? t.current : {};
    const members = Array.isArray(t.members) ? t.members : [];
    const g = {};
    if (members.includes('protected_paths') && cur.protected_paths) g.protected_paths = cur.protected_paths;
    if (members.includes('check_discovery') && cur.check_discovery) g.check_discovery = cur.check_discovery;
    g.check_commands = { ...(cur.check_commands ?? {}), [rt.name]: { path: rt.path, ...(rt.sha256 ? { sha256: rt.sha256 } : {}) } };
    const readPaths = [...new Set([...(cur.read_paths ?? []), ...(rt.read_paths ?? [])])];
    const dirs = [...new Set([...(rt.path_dirs ?? [path.dirname(rt.path)]), ...(cur.path ?? [])])];
    g.runner_config = { direct: { read_paths: readPaths, path: dirs } };
    return { file: t.file, text: `${JSON.stringify(g, null, 2)}\n`, program: rt.name };
  }

  function definitionsDir(R) {
    const t = R['verifier.toolchain'];
    const cur = t && t.current && typeof t.current === 'object' ? t.current : null;
    return (cur && cur.check_discovery && cur.check_discovery.definitions) || '.surety/checks/defs/';
  }

  // The program a definition names: one the governed values already name,
  // else the toolchain's runtime this run writes in.
  function programOf(R, governed) {
    const t = R['verifier.toolchain'];
    const named = t && t.current && t.current.check_commands ? Object.keys(t.current.check_commands) : [];
    return named[0] ?? (governed ? governed.program : null);
  }

  const had0 = (ws, dir) => ws.list(dir).some((n) => n.endsWith('.json'));

  function existingKinds(ws, dir) {
    const out = new Set();
    for (const n of ws.list(dir)) {
      const d = parse(ws.read(`${dir}${n}`), null);
      if (d && d.kind) out.add(d.kind);
    }
    return out;
  }

  function checkDefinition(pkg, content, { key, kind, criteria = [], areas = [], gates, postDeploy = false, env = null, program = null }) {
    const R = pkg.reads;
    const body = (content.checks ?? {})[key] ?? { files: { [`.surety/checks/run/${key}.mjs`]: `// rehearsal check ${key}\nprocess.exit(0);\n` }, run: [`.surety/checks/run/${key}.mjs`] };
    const d = { schema: 1, key };
    if (kind) d.kind = kind;
    d.command = [...(program ? [program] : []), ...body.run];
    d.timeout_s = 120;
    d.gate_kinds = gates;
    const cv = R['verifier.covers'];
    if (cv && (criteria.length > 0 || areas.length > 0)) d.covers = { ...(criteria.length > 0 ? { [cv.criteria]: criteria } : {}), ...(areas.length > 0 ? { [cv.sensitive_areas]: areas } : {}) };
    if (postDeploy) {
      const rq = R['verifier.requires'];
      if (rq && Array.isArray(rq.values)) d[rq.member] = rq.values;
      const sc = R['verifier.secrets'];
      const allowed = sc && Array.isArray(sc.environments) ? [...new Set(sc.environments.filter((e) => e && e.name === env && Array.isArray(e.check_secrets)).flatMap((e) => e.check_secrets))] : [];
      if (sc && allowed.length > 0) d[sc.member] = allowed;
    }
    d.inputs = Object.keys(body.files);
    return { d, files: body.files };
  }

  function authoringRun(pkg, ws, content) {
    const R = pkg.reads;
    const a = parse(pkg.files['authoring.json'], null);
    if (!a) return shapeResult(pkg, { summary: 'no authoring facts in the package; nothing written' });
    const kinds = R['verifier.kinds'];
    const criteriaKinds = kinds && Array.isArray(kinds.criteria_kinds) ? kinds.criteria_kinds : [];
    const accept = criteriaKinds.includes('acceptance') ? 'acceptance' : null;
    const floor = R['verifier.gate_kinds_floor'];
    const gates = floor && Array.isArray(floor.gate_kinds) ? floor.gate_kinds : ['stage'];
    const floorKinds = floor && Array.isArray(floor.floor) ? floor.floor : [];
    const dir = definitionsDir(R);
    const governed = had0(ws, dir) ? null : governedFrom(R);
    const program = programOf(R, governed);
    const had = existingKinds(ws, dir);
    const first = had.size === 0;
    const out = [];
    const adoptRule = R['verifier.adoption_rule'];
    const adopted = [];
    const adoptedCriteria = new Set();
    if (adoptRule && Array.isArray(content.adopt)) {
      for (const t of content.adopt) {
        for (const [p, text] of Object.entries(t.files)) ws.write(p, text);
        out.push(checkDefinition(pkg, { ...content, checks: { [t.key]: { files: t.files, run: t.run } } }, { program, key: t.key, kind: accept, criteria: t.criteria, gates }));
        adopted.push({ from: t.from, to: t.to, criteria: t.criteria, dependency_boundary: t.dependency_boundary });
        for (const c of t.criteria) adoptedCriteria.add(c);
      }
    }
    for (const s of a.stages ?? []) {
      const crit = (s.validation && s.validation.criteria) || [];
      for (const key of s.implements ?? []) {
        const mine = crit.filter((c) => c.startsWith(`${key}.`) && !adoptedCriteria.has(c));
        if (mine.length > 0) out.push(checkDefinition(pkg, content, { program, key: `accept-${key.toLowerCase()}`, kind: accept, criteria: mine, gates }));
      }
      for (const k of floorKinds.filter((k) => criteriaKinds.includes(k) && k !== 'acceptance')) {
        if (crit.length > 0) out.push(checkDefinition(pkg, content, { program, key: `${k}-s${s.number}`, kind: k, criteria: [crit[crit.length - 1]], gates }));
      }
    }
    for (const k of floorKinds.filter((k) => !criteriaKinds.includes(k) && !had.has(k))) out.push(checkDefinition(pkg, content, { program, key: k === 'security_lint' ? 'lint' : k, kind: k, gates }));
    const pd = R['verifier.post_deploy'];
    if (pd && Array.isArray(pd.environments) && !had.has(pd.required)) {
      const envs = [...new Set(pd.environments.filter((e) => e && Array.isArray(e.targets) && e.targets.length > 0).map((e) => e.name))];
      for (const e of envs.map((name) => ({ name }))) out.push(checkDefinition(pkg, content, { program, key: 'operation', kind: pd.required, gates: [pd.gate_kind], postDeploy: true, env: e.name }));
    }
    for (const { d, files } of out) {
      for (const [p, text] of Object.entries(files)) ws.write(p, text);
      ws.write(`${dir}${d.key}.json`, `${JSON.stringify(d, null, 2)}\n`);
    }
    let governedChanges;
    if (first && governed) {
      ws.write(governed.file, governed.text);
      governedChanges = { check_commands: true, programs: [governed.program] };
    }
    return shapeResult(pkg, {
      summary: `wrote ${out.length} checks for phase ${a.phase_plan ? a.phase_plan.phase_number : '?'}`,
      proposal: { rationale: 'the phase\'s checks, from the plan\'s validation and the package\'s rules', requested_change_kind: first ? 'unclassifiable' : 'tightening' },
      governed_changes: governedChanges,
      deferred_criteria: [],
      adopted_tests: adopted.length > 0 ? adopted : undefined,
    });
  }

  function correctionRun(pkg, ws, content) {
    const req = parse(pkg.files['change_request.json'], {}) ?? {};
    const open = Array.isArray(req.open_obligations) ? req.open_obligations : [];
    const named = new Set(open.flatMap((o) => [o.check_key, o.key, o.check].filter((x) => typeof x === 'string')));
    const corrections = content.corrections ?? {};
    const keys = Object.keys(corrections).filter((k) => named.size === 0 || named.has(k) || [...named].some((n) => n.endsWith(k)));
    for (const k of keys.length > 0 ? keys : Object.keys(corrections)) for (const [p, text] of Object.entries(corrections[k])) ws.write(p, text);
    return shapeResult(pkg, { summary: 'the checks the change obliges, corrected', proposal: { rationale: 'the specification changed; the checks it names now read the new text', requested_change_kind: 'tightening' } });
  }

  // ---- the Builder (its stage, from its package) -----------------------------------------------

  function builderRun(pkg, ws, content) {
    const R = pkg.reads;
    const tasks = R['builder.tasks'];
    const impl = R['builder.implements'];
    const deps = R['builder.dependency_interfaces'];
    const obligations = R['builder.integration_obligations'];
    const paths = tasks && Array.isArray(tasks.tasks) ? [...new Set(tasks.tasks.flatMap((t) => [...String(t).matchAll(/`([^`]+)`/g)].map((m) => m[1])))] : [];
    const keys = impl && Array.isArray(impl.implements) ? impl.implements : [];
    const wrote = [];
    for (const p of paths) {
      const variants = (content.code ?? {})[p] ?? {};
      const k = [...keys].reverse().find((x) => x in variants);
      if (!k) continue;
      let body = variants[k];
      body = body.replace(/\{\{dep:([A-Za-z0-9_-]+)\}\}/g, (_, name) => {
        const i = deps && Array.isArray(deps.interfaces) ? deps.interfaces.find((x) => x && x.name === name) : null;
        if (!i || !i.path) return `MISSING-DEPENDENCY-${name}`;
        const rel = path.posix.relative(path.posix.dirname(p), i.path);
        return rel.startsWith('.') ? rel : `./${rel}`;
      });
      ws.write(p, body);
      wrote.push(p);
    }
    const met = obligations && Array.isArray(obligations.integration_obligations) ? obligations.integration_obligations : [];
    return shapeResult(pkg, { summary: `wrote ${wrote.join(', ') || 'nothing'}${met.length > 0 ? `; integration obligations kept: ${met.join('; ')}` : ''}` });
  }

  // ---- the rest: verification, review, phase verification, fix ----------------------------------

  function reviewerRun(pkg) {
    const proposal = parse(pkg.files['proposal.json'], null);
    if (proposal && typeof proposal.id === 'string') return shapeResult(pkg, { summary: `approving ${proposal.id}`, proposal_approval: { proposal: proposal.id, reason: 'The approved specification requires these checks.' } });
    return shapeResult(pkg, { summary: 'signed off', signoffs: [{ scope: 'candidate' }] });
  }

  // ---- dispatch ------------------------------------------------------------------------------

  function play({ context, workspace, content = {} }) {
    const pkg = readPackage(context);
    const ws = writer(workspace);
    ws.root = workspace;
    const role = pkg.manifest.role;
    const kind = pkg.manifest.kind;
    let result;
    if (kind === 'session' && role === 'spec_writer') result = specWriterTurn(pkg, ws);
    else if (kind === 'session' && role === 'architect') result = architectTurn(pkg, ws);
    else if (kind === 'session') result = shapeResult(pkg, { summary: 'rehearsal', reply: 'Noted.', artifact_changed: false });
    else if (kind === 'replan') result = replanRun(pkg, ws);
    else if (kind === 'spec_change') result = specChangeRun(pkg, ws);
    else if (kind === 'check_authoring') result = authoringRun(pkg, ws, content);
    else if (kind === 'check_correction') result = correctionRun(pkg, ws, content);
    else if (kind === 'stage_build') result = builderRun(pkg, ws, content);
    else if (role === 'reviewer') result = reviewerRun(pkg);
    else if (kind === 'phase_verification') {
      // The sign-off in the form the package states it (verifier.phase_signoff).
      const ps = pkg.reads['verifier.phase_signoff'];
      result = shapeResult(pkg, { summary: 'the phase verified', ...(ps ? { [ps.field]: [ps.item] } : {}) });
    }
    else result = shapeResult(pkg, { summary: `rehearsal: ${role} ${kind}` });
    delete result._governed;
    return { role, kind, blocks: pkg.reads, written: ws.written, result };
  }

  return { play, readPackage, readSpec, taggedBlock, prune };
})();
if (typeof module !== 'undefined' && module && module.exports) module.exports = SURETY_PACKAGE_FAKES;
