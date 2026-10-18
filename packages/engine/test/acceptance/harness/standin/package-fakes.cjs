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
  const crypto = require('node:crypto');

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
      // M6 slice 46: a file the fake owns removed; a package file copied byte for byte.
      remove(rel) {
        try {
          fs.rmSync(path.join(workspace, rel), { recursive: true, force: true });
        } catch {
          // nothing to remove
        }
      },
      copyFrom(abs, rel) {
        const p = path.join(workspace, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.copyFileSync(abs, p);
        written[rel] = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`;
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
    const descriptive = [];
    let under = null;
    for (const line of secs[4] ?? []) {
      const m = /^- (R\d+\.\d+)\s+(.*)$/.exec(line);
      if (m) criteriaText[m[1]] = m[2];
      const h = /^### (R\d+)\b/.exec(line);
      if (h) under = h[1];
      else if (under && /^\*\*Descriptive\.\*\*/.test(line.trim())) descriptive.push(under);
    }
    return { descriptive, version: Number(field('Spec version')) || null, tier: ((field('Tier') || '').match(/T[123]/) || [null])[0], index, criteriaText, modules: tableOf(secs[6]).map((r) => ({ name: r.Module, areas: (r['Sensitive areas'] || '').split(',').map((s) => s.trim()).filter((s) => s && s !== 'none') })) };
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
    const tg = R['spec_writer.targets'];
    // A requirement's surface mark in the element's form, from the owner's `ui (<targets>)` (or `ui`).
    const surfaceLine = (surface) => {
      if (!tg || !tg.surface || typeof surface !== 'string') return null;
      const m = /^\s*ui\s*(?:\(([^)]*)\))?\s*$/.exec(surface);
      if (!m) return null;
      const ts = m[1] ? m[1].split(',').map((x) => x.trim()).filter(Boolean) : [];
      return ts.length > 0 && tg.surface.with_targets ? String(tg.surface.with_targets).replace('<targets>', ts.join(tg.surface.separator ?? ', ')) : tg.surface.mark;
    };
    const header = R['spec_writer.header_fields'];
    if (header && Array.isArray(header.fields)) {
      for (const f of header.fields) {
        const n = String(f.name ?? '');
        const value = /version/i.test(n) ? String(o.spec_version ?? 1) : /status/i.test(n) ? (f.value ?? 'draft') : /tier/i.test(n) ? tierOf(o.tier) : /owner/i.test(n) ? o.owner : '';
        L.push(`${f.line} ${value}`);
      }
      // The product's targets and the cross-platform line, from `spec_writer.targets` alone
      // (objection 202); told nothing of the element, neither is written.
      if (tg && tg.targets && Array.isArray(o.targets) && o.targets.length > 0) {
        L.push(`${tg.targets.line} ${o.targets.filter((t) => !Array.isArray(tg.targets.values) || tg.targets.values.includes(t)).join(tg.targets.separator ?? ', ')}`);
        if (o.cross_platform && tg.cross_platform) L.push(`${tg.cross_platform.line} ${tg.cross_platform.value}`);
      }
      L.push('');
    }
    L.push('## 1. Purpose', '', o.purpose ?? '', '', '## 2. Non-goals', '', ...(o.non_goals ?? []).map((x) => `- ${x}`), '', '## 3. Users and situations', '', o.users ?? '', '');
    const form = R['spec_writer.requirement_form'];
    L.push(form && form.section ? form.section : '## 4. Requirements', '');
    const marks = R['spec_writer.marks'];
    for (const r of o.requirements ?? []) {
      if (form) {
        const surface = surfaceLine(r.surface);
        L.push(String(form.heading).replace('R<n>', r.key).replace('<title>', r.title), '', r.statement, '', ...(surface ? [surface, ''] : []), `**Rationale.** ${r.rationale ?? 'The owner asked for it.'}`, '', `${form.sensitive_areas} ${areas(r.areas)}`, '');
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
      // Each cell's syntax from `spec_writer.index_cells` alone (the review's M5): its list
      // separator; told nothing of it, the fake joins a list in words.
      const cells = R['spec_writer.index_cells'];
      const sep = cells && typeof cells.list_separator === 'string' ? cells.list_separator : ' and ';
      const areaCell = (xs) => (Array.isArray(xs) && xs.length > 0 ? xs.map(areaOf).join(sep) : areas(xs));
      for (const r of o.requirements ?? []) {
        const cell = (c) =>
          ({ Key: r.key, Title: r.title, Phase: String(r.phase ?? ''), 'Sensitive areas': areaCell(r.areas), Criteria: (r.criteria ?? []).map((c) => c.id).join(sep), Origin: r.origin ?? idx.default_origin ?? '' })[c] ?? '';
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
      // The module whose interfaces cite the key; else (a module with no
      // interface of its own, a UI module) the module the map assigns the
      // requirement to (its `requirements`), its tasks its own paths.
      const citingOwners = modules.filter((m) => (m.interfaces ?? []).some((f) => citing(f.description, key)));
      const owned = citingOwners.length > 0 ? citingOwners : modules.filter((m) => Array.isArray(m.requirements) && m.requirements.includes(key));
      const ifaces = owned.flatMap((m) => (m.interfaces ?? []).filter((f) => citing(f.description, key)));
      const byPath = {};
      for (const f of ifaces) (byPath[f.path ?? f.name] ??= []).push(f.description);
      // A module's own paths where no interface path lies under them (an http
      // interface's path is a route, not a file): the module's files are the task.
      for (const m of owned) {
        const mine = (m.paths ?? []).filter((mp) => typeof mp === 'string');
        const covered = ifaces.some((f) => mine.some((mp) => String(f.path ?? '').startsWith(mp)));
        if (citingOwners.length === 0 || !covered) for (const mp of mine) (byPath[mp] ??= []).push(`${m.name}'s files for ${key}`);
      }
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

  // What a plan's prepared_against and roadmap.json's versions name, from
  // `architect.prepared_against` alone (the slice-38 review's S2): never a
  // version of the fake's own, never the workspace's HEAD read by itself.
  function preparedOf(pkg, roadmapChanged) {
    const pa = pkg.reads['architect.prepared_against'];
    const f = pa && pa.facts ? pa.facts : null;
    if (!f) return null;
    const roadmap = roadmapChanged && pa.roadmap_version_if_changed !== undefined ? pa.roadmap_version_if_changed : f.roadmap_version;
    return { spec_version: f.spec_version, architecture_version: f.architecture_version, roadmap_version: roadmap, revision: f.revision };
  }
  const constOf = (schema, key) => (schema && schema.properties && schema.properties[key] && 'const' in schema.properties[key] ? schema.properties[key].const : undefined);

  function writeArchitectFiles(pkg, ws, { arch, spec, phase, roadmapToo, stages, conformance }) {
    const prepared = preparedOf(pkg, roadmapToo);
    const R = pkg.reads;
    const S = (id) => (R[id] && R[id].schema ? R[id] : null);
    if (roadmapToo) {
      ws.write('.surety/architecture/architecture.md', `# Architecture\n\n${arch.architecture ?? ''}\n`);
      if (S('architect.schema.modules')) ws.write(R['architect.schema.modules'].file, `${JSON.stringify(prune(R['architect.schema.modules'].schema, { version: constOf(R['architect.schema.modules'].schema, 'version'), modules: arch.modules, mapping_from_spec: arch.mapping ?? [] }), null, 2)}\n`);
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
        ws.write(R['architect.schema.roadmap'].file, `${JSON.stringify(prune(R['architect.schema.roadmap'].schema, { version: prepared ? prepared.roadmap_version : undefined, architecture_version: prepared ? prepared.architecture_version : undefined, phases: (arch.phases ?? []).map((p) => ({ number: p.number, goal: p.goal, modules: p.modules, requirement_ids: p.requirements, depends_on: p.depends_on ?? [] })) }), null, 2)}\n`);
      }
    }
    if (S('architect.schema.phase_plan')) {
      // Routing is computed from the artifacts (§5.4): a plan that changes no
      // approved artifact is within its baseline. Told nothing of routing, a
      // careful Architect declares its plan uncertain.
      const declared = R['architect.routing'] ? 'within_baseline' : 'uncertain';
      const plan = { phase, prepared_against: prepared ?? undefined, stages, conformance: declared, notes: conformance ? 'the conformance phase' : undefined };
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
    writeArchitectFiles(pkg, ws, { arch, spec, phase: 1, roadmapToo: true, stages, conformance: arch.conformance_phase === 1 });
    return shapeResult(pkg, { summary: 'wrote the architecture and the first plan', reply: 'The architecture, module map, ADRs, roadmap and phase 1.', artifact_changed: true, done: true });
  }

  // A replan of the open phase, replacing its plan (the package's
  // `open-plan.json`; the prompt's "the open phase <n>, replacing its plan"):
  // from the package alone. Kept stages (the prompt's "Kept stages: stage
  // <n> …", else the open plan's stages it states integrated or verified)
  // are omitted, which the kept-stage rule says is always valid. Each
  // criterion a kept stage's requirement gained since it was built (the
  // specification's criteria not in its validation as built) or that the
  // trigger touched (the prompt's list, else trigger.json's stale
  // `criterion:` entries) is planned in a new stage, under a new number, on
  // the kept stage's modules, tasks and ADRs, validating only those. A
  // stage not yet built is listed again with its inputs, validating every
  // current criterion of what it implements. A requirement of the phase
  // that no stage implements gets a stage as a first plan does; one with
  // no criterion (a human test, `index.json`'s `human_test`) gets none.
  function openReplanRun(pkg, ws, open) {
    const f = pkg.files;
    const spec = readSpec(f['spec.md']);
    const roadmap = parse(f['roadmap.json'], null);
    const map = parse(f['module_map.json'], null);
    if (!spec || !roadmap || !map) throw new Error(`rehearsal fake: the open phase's replan package lacks its facts (spec.md ${Boolean(spec)}, roadmap.json ${Boolean(roadmap)}, module_map.json ${Boolean(map)})`);
    const phase = Number(open.phase_number);
    const phases = Array.isArray(roadmap.phases) ? roadmap.phases : Array.isArray(roadmap) ? roadmap : [];
    const ph = phases.find((x) => Number(x.number) === phase);
    if (!ph) throw new Error(`rehearsal fake: no phase ${phase} in the package's roadmap`);
    const modules = Array.isArray(map.modules) ? map.modules : Array.isArray(map) ? map : [];
    const R = pkg.reads;
    const kinds = R['architect.plan_reasons'] && R['architect.plan_reasons'].kinds_by_tier ? (R['architect.plan_reasons'].kinds_by_tier[spec.tier] ?? []) : [];
    const crit = (k) => (spec.index.find((r) => r.key === k) || { criteria: [] }).criteria;
    const index = parse(f['index.json'], []) || [];
    const humanOnly = (k) => crit(k).length === 0 && (Array.isArray(index) ? index.some((x) => x && x.key === k && x.human_test === true) : false);
    const stages = (open.stages || []).filter((st) => !st.cancelled_at);
    const keptList = /Kept stages: (.*?)\. Their inputs/.exec(pkg.prompt);
    const keptNumbers = keptList ? [...keptList[1].matchAll(/stage (\d+)/g)].map((m) => Number(m[1])) : stages.filter((st) => st.status === 'integrated' || st.status === 'verified').map((st) => Number(st.number));
    const touchedLine = /Criteria this replan's trigger touched \(gained or changed\): ([^.]*)\./.exec(pkg.prompt);
    const trig = parse(f['trigger.json'], null);
    const staleCriteria = trig && Array.isArray(trig.stale) ? trig.stale.map((x) => (typeof x === 'string' ? x : x && (x.subject || x.id))).filter((x) => typeof x === 'string' && x.startsWith('criterion:')).map((x) => x.slice('criterion:'.length)) : [];
    const touched = new Set([...(touchedLine ? touchedLine[1].split(',').map((x) => x.trim()).filter(Boolean) : []), ...staleCriteria]);
    const adrs = Object.keys(f).filter((n) => /^adrs\/.+\.md$/.test(n)).map((n) => path.basename(n, '.md'));
    let next = Math.max(0, ...stages.map((st) => Number(st.number) || 0));
    // A stage's dependencies as its package states them, which a real
    // Architect copies into the plan: the plan's form (the package's
    // `architect.schema.phase_plan`) takes stage numbers. Anything else
    // (a stage id) is never translated here (SEAM.md §548): the play fails
    // naming it, so an engine that states the open plan in a form its own
    // plan check refuses is seen, never papered over.
    const asBuilt = (st) => {
      const d = Array.isArray(st.depends_on) ? st.depends_on : [];
      const bad = d.filter((x) => !(Number.isInteger(x) && x > 0));
      if (bad.length > 0 || !Array.isArray(st.depends_on)) throw new Error(`rehearsal fake: the package's open plan (open-plan.json) states stage ${st.number}'s depends_on as ${JSON.stringify(st.depends_on)}, not as the stage numbers the plan's form takes (architect.schema.phase_plan); copied as built it is refused, and the fake does not translate it`);
      return d;
    };
    const out = [];
    const implemented = new Set();
    for (const st of stages) {
      const impl = Array.isArray(st.implements) ? st.implements : [];
      impl.forEach((k) => implemented.add(k));
      const v = st.validation && typeof st.validation === 'object' ? st.validation : {};
      if (keptNumbers.includes(Number(st.number))) {
        const built = new Set(Array.isArray(v.criteria) ? v.criteria : []);
        for (const k of impl) {
          const gained = crit(k).filter((c) => !built.has(c) || touched.has(c));
          if (gained.length === 0) continue;
          next += 1;
          out.push({ number: next, goal: `${k}: the criteria it gained since stage ${st.number} was built`, tasks: st.tasks ?? [], modules: st.modules ?? [], implements: [k], adrs: st.adrs ?? adrs, depends_on: asBuilt(st), validation: { criteria: gained, kinds: kinds.length > 0 ? kinds : (v.kinds ?? []), sensitive_areas: v.sensitive_areas ?? [] }, integration_obligations: st.integration_obligations ?? [] });
        }
        continue;
      }
      out.push({ number: Number(st.number), goal: st.goal, tasks: st.tasks ?? [], modules: st.modules ?? [], implements: impl, adrs: st.adrs ?? adrs, depends_on: asBuilt(st), validation: { ...v, criteria: [...new Set(impl.flatMap(crit))] }, integration_obligations: st.integration_obligations ?? [] });
    }
    const missing = (ph.requirement_ids ?? ph.requirements ?? []).filter((k) => !implemented.has(k) && !humanOnly(k) && crit(k).length > 0);
    if (missing.length > 0) {
      const obligations = {};
      for (const st of stages) for (const m of st.modules ?? []) if (Array.isArray(st.integration_obligations) && st.integration_obligations.length > 0) obligations[m] = st.integration_obligations;
      out.push(...stagesFor(pkg, { phase, requirements: missing, modules, spec, adrs, obligations, base: next, conformance: false }).map((x) => ({ ...x, depends_on: [] })));
    }
    const declared = writeArchitectFiles(pkg, ws, { arch: {}, spec, phase, roadmapToo: false, stages: out });
    return shapeResult(pkg, { summary: `the open phase ${phase} replanned: ${out.map((x) => `stage ${x.number}`).join(', ') || 'no new stage'}`, plan: `phase-${phase}`, conformance: declared ?? 'uncertain' });
  }

  function replanRun(pkg, ws, content) {
    const f = pkg.files;
    // The open phase, replacing its plan (an early replacement, a change's replan of the phase under way).
    const openPlan = parse(f['open-plan.json'], null);
    if (openPlan && Number.isInteger(Number(openPlan.phase_number)) && Array.isArray(openPlan.stages)) return openReplanRun(pkg, ws, openPlan);
    // A replacement of an open plan's generation (trigger.json's `replaces`)
    // whose package carries no open plan: the generation it replaces is no
    // longer open (SEAM.md §548). Never planned as the next phase.
    const trig = parse(f['trigger.json'], null);
    if (trig && trig.replaces) throw new Error(`rehearsal fake: the package replaces generation ${trig.replaces.generation} of the plan ${trig.replaces.phase_plan} (trigger.json) but carries no open plan (open-plan.json); its prompt says: ${(/^Plan the next phase.*$/m.exec(pkg.prompt || '') || ['(no replan line)'])[0]}`);
    const gen = parse(f['generation.json'], {}) ?? {};
    const spec = readSpec(f['spec.md']);
    const roadmap = parse(f['roadmap.json'], null);
    const map = parse(f['module_map.json'], null);
    const done = parse(f['plan.json'], null);
    // A package without its facts fails loudly (M7 of the slice-38 review), never a quiet result.
    if (!spec || !roadmap || !map || !done) throw new Error(`rehearsal fake: the replan package lacks its facts (spec.md ${Boolean(spec)}, roadmap.json ${Boolean(roadmap)}, module_map.json ${Boolean(map)}, plan.json ${Boolean(done)})`);
    const phases = Array.isArray(roadmap.phases) ? roadmap.phases : Array.isArray(roadmap) ? roadmap : [];
    const next = (done.phase_number ?? 0) + 1;
    const ph = phases.find((p) => Number(p.number) === next);
    if (!ph) throw new Error(`rehearsal fake: no phase ${next} in the package's roadmap`);
    const modules = Array.isArray(map.modules) ? map.modules : Array.isArray(map) ? map : [];
    const base = Math.max(0, ...(done.stages ?? []).map((s) => Number(s.number) || 0));
    const adrs = Object.keys(f).filter((n) => /^adrs\/.+\.md$/.test(n)).map((n) => path.basename(n, '.md'));
    const obligations = {};
    for (const s of done.stages ?? []) for (const m of s.modules ?? []) if (Array.isArray(s.integration_obligations) && s.integration_obligations.length > 0) obligations[m] = s.integration_obligations;
    const stages = stagesFor(pkg, { phase: next, requirements: ph.requirement_ids ?? ph.requirements ?? [], modules, spec, adrs, obligations, base, conformance: false });
    void gen;
    const declared = writeArchitectFiles(pkg, ws, { arch: {}, spec, phase: next, roadmapToo: false, stages });
    // In an adopted project's replan, a change request for each descriptive
    // requirement the phase holds, in the form the package states
    // (architect.spec_change_requests); its text the owner's (CONTENT).
    const scr = pkg.reads['architect.spec_change_requests'];
    const wanted = (ph.requirement_ids ?? ph.requirements ?? []).filter((k) => (spec.descriptive ?? []).includes(k));
    const requests = scr ? wanted.map((k) => {
      const text = ((content && content.descriptive_criteria) || {})[k];
      if (typeof text !== 'string') throw new Error(`rehearsal fake: no criteria text for the descriptive requirement ${k} in the rehearsal's content`);
      return { keys: [k], text };
    }) : [];
    return shapeResult(pkg, { summary: `phase ${next} planned`, plan: `phase-${next}`, conformance: declared ?? 'uncertain', ...(scr && requests.length > 0 ? { [scr.field]: requests } : {}) });
  }

  // ---- the Spec Writer's change (B.7) ------------------------------------------------------

  // A design batch's change (`spec_writer.design_change`; D7 §7.1, §7.3;
  // objection 202), written from the package alone: each design criterion
  // under its requirement at the next free id, its text exactly as given;
  // each human test a new requirement at the next free key, with the
  // surface mark and the human-test mark, at its phase in the index; the
  // version raised. The forms are the package's (`spec_writer.requirement_form`,
  // `spec_writer.index_columns`, `spec_writer.index_cells`,
  // `spec_writer.sensitive_areas`, `spec_writer.change_result`).
  function designChangeRun(pkg, ws, dc) {
    const R = pkg.reads;
    const text = ws.read('.surety/spec/spec.md');
    if (text === null) throw new Error('rehearsal fake: the design change found no specification at .surety/spec/spec.md');
    const form = R['spec_writer.requirement_form'];
    const idx = R['spec_writer.index_columns'];
    const cells = R['spec_writer.index_cells'];
    const sep = cells && typeof cells.list_separator === 'string' ? cells.list_separator : ', ';
    const areaList = R['spec_writer.sensitive_areas'];
    const none = areaList && areaList.none ? areaList.none : 'none';
    const crit = dc.criterion || {};
    const ht = dc.human_test || {};
    const lines = text.split('\n');
    const reqHead = (key) => lines.findIndex((l) => new RegExp(`^### ${key}\\b`).test(l));
    const sectionEnd = (from) => {
      for (let i = from + 1; i < lines.length; i++) if (/^#{2,3} /.test(lines[i])) return i;
      return lines.length;
    };
    const keys = () => lines.map((l) => /^### R(\d+)\b/.exec(l)).filter(Boolean).map((m) => Number(m[1]));
    const changes = [];
    const added = {};
    for (const c of dc.criteria || []) {
      const key = c.requirement;
      if (typeof key !== 'string' || !/^R\d+$/.test(key)) throw new Error(`rehearsal fake: a design criterion under ${JSON.stringify(key)} (a requirement of its own is not played)`);
      const at = reqHead(key);
      if (at < 0) throw new Error(`rehearsal fake: the specification has no requirement ${key} for a design criterion`);
      const end = sectionEnd(at);
      const mine = new RegExp(`^- ${key}\\.(\\d+) `);
      let last = -1;
      let top = 0;
      for (let i = at; i < end; i++) {
        const m = mine.exec(lines[i]);
        if (m) {
          last = i;
          top = Math.max(top, Number(m[1]));
        }
      }
      if (last < 0) throw new Error(`rehearsal fake: requirement ${key} has no criteria list to add to`);
      const id = `${key}.${top + 1}`;
      lines.splice(last + 1, 0, form && form.criterion ? String(form.criterion).replace('R<n>.<m>', id).replace('<text>', c.text) : `- ${id} ${c.text}`);
      (added[key] ??= []).push(id);
      const kind = crit.change_kind ?? 'criteria_added';
      if (!changes.some((x) => x.key === key && x.kind === kind)) changes.push({ key, kind, reason: 'the approved design\'s criteria' });
    }
    const indexAt = () => (idx && idx.section ? lines.findIndex((l) => l.trim() === String(idx.section).trim()) : -1);
    const newRows = [];
    for (const h of dc.human_tests || []) {
      const key = `R${Math.max(0, ...keys()) + 1}`;
      const title = `The ${h.target} UI matches the approved design`;
      const at = indexAt();
      if (at < 0) throw new Error('rehearsal fake: the specification has no requirement index to place a human test before');
      const heading = form && form.heading ? String(form.heading).replace('R<n>', key).replace('<title>', title) : `### ${key}. ${title}`;
      const block = [heading, '', `A person judges the ${h.target} UI against the approved design.`, '', String(ht.surface ?? '').replace('<target>', h.target), '', '**Rationale.** The approved design.', '', `${form && form.sensitive_areas ? form.sensitive_areas : '**Sensitive areas:**'} ${none}`, '', ht.mark ?? '**Human test.**', '', h.text, ''];
      lines.splice(at, 0, ...block);
      newRows.push({ key, title, phase: h.phase === null || h.phase === undefined ? '' : String(h.phase) });
      changes.push({ key, kind: ht.change_kind ?? 'added', reason: `the ${h.target} human test of the approved design` });
    }
    // The index: each criterion added to its row's Criteria cell; a row per human test.
    if (idx && Array.isArray(idx.columns)) {
      const at = indexAt();
      let end = at + 1;
      while (end < lines.length && !/^## /.test(lines[end])) end++;
      const cellsOf = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((x) => x.trim());
      const ci = idx.columns.indexOf('Criteria');
      let lastRow = -1;
      for (let i = at + 1; i < end; i++) {
        if (!lines[i].trim().startsWith('|')) continue;
        lastRow = i;
        const cs = cellsOf(lines[i]);
        if (ci >= 0 && added[cs[0]]) {
          cs[ci] = [...cs[ci].split(sep.trim()).map((x) => x.trim()).filter(Boolean), ...added[cs[0]]].join(sep);
          lines[i] = `| ${cs.join(' | ')} |`;
        }
      }
      if (lastRow < 0) throw new Error('rehearsal fake: the requirement index has no rows');
      lines.splice(lastRow + 1, 0, ...newRows.map((r) => `| ${idx.columns.map((c) => ({ Key: r.key, Title: r.title, Phase: r.phase, 'Sensitive areas': none, Criteria: '', Origin: idx.default_origin ?? '' })[c] ?? '').join(' | ')} |`));
    }
    ws.write('.surety/spec/spec.md', lines.join('\n').replace(/^(\*\*Spec version:\*\*)\s*(\d+)/m, (_, a, n) => `${a} ${Number(n) + 1}`));
    const cr = R['spec_writer.change_result'];
    const kinds = cr && cr.item && Array.isArray(cr.item.kind) ? cr.item.kind : [];
    const listed = cr ? changes.filter((c) => kinds.includes(c.kind)) : [];
    return shapeResult(pkg, { summary: 'the approved design written into the specification', ...(cr ? { [cr.field]: listed } : {}) });
  }

  function specChangeRun(pkg, ws) {
    // A design batch's change, played from the element that states it (objection 202).
    const dc = pkg.reads['spec_writer.design_change'];
    if (dc && dc.source === 'design') return designChangeRun(pkg, ws, dc);
    const req = parse(pkg.files['change_request.json'], {}) ?? {};
    const change = taggedBlock(req.text ?? req.request_text ?? '', 'rehearsal-change') ?? taggedBlock(pkg.prompt, 'rehearsal-change');
    let text = ws.read('.surety/spec/spec.md');
    if (!change || text === null) throw new Error(`rehearsal fake: the change could not be read (the request's rehearsal-change block ${Boolean(change)}, the specification ${text !== null})`);
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
  // else the toolchain's runtime this run writes in, else (a package that
  // states no toolchain: the correction's, M442) the first of the programs
  // `verifier.design_catalogue`'s `command` states (objection 201). Its
  // `programs` null is unknown: no program is named, and discovery refuses
  // the definition where the engine reads it.
  function programOf(R, governed) {
    const t = R['verifier.toolchain'];
    const named = t && t.current && t.current.check_commands ? Object.keys(t.current.check_commands) : [];
    if (named[0] !== undefined) return named[0];
    if (governed) return governed.program;
    const dc = R['verifier.design_catalogue'];
    const programs = dc && dc.command && Array.isArray(dc.command.programs) ? dc.command.programs.filter((x) => typeof x === 'string' && x.length > 0) : [];
    return programs[0] ?? null;
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
    // The target's variable and its value's form from `verifier.target_variables` alone
    // (the review's S1); told nothing of them, a marker the judgement names.
    let files = body.files;
    if (postDeploy) {
      const tv = R['verifier.target_variables'];
      const t = tv && Array.isArray(tv.environments) ? tv.environments.filter((e) => e && e.name === env && Array.isArray(e.targets)).flatMap((e) => e.targets)[0] : null;
      const name = t && typeof t.variable === 'string' ? t.variable : 'MISSING-TARGET-VARIABLE';
      const url = t ? (String(tv.value_form).startsWith('http') ? `process.env.${name}` : `'http://' + process.env.${name}`) : 'MISSING-TARGET-VARIABLE';
      files = Object.fromEntries(Object.entries(files).map(([p, text]) => [p, String(text).replace(/\{\{target:url\}\}/g, url).replace(/\{\{target:name\}\}/g, name)]));
    }
    d.inputs = Object.keys(files);
    return { d, files };
  }

  function authoringRun(pkg, ws, content) {
    const R = pkg.reads;
    const a = parse(pkg.files['authoring.json'], null);
    if (!a) throw new Error('rehearsal fake: the authoring package lacks authoring.json');
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
    // Adoption in the form the adoption rule states (D6 §8.3): its field, its
    // protected root and its dispositions; what is copied is the CONTENT's.
    if (adoptRule && Array.isArray(content.adopt)) {
      const allowed = Array.isArray(adoptRule.dispositions) ? adoptRule.dispositions : [];
      for (const t of content.adopt) {
        if (!String(t.to).startsWith(adoptRule.protected_root ?? '\u0000')) continue;
        const boundary = (t.dependency_boundary ?? []).filter((b) => allowed.includes(b.disposition));
        if (boundary.length !== (t.dependency_boundary ?? []).length) continue;
        for (const [p, text] of Object.entries(t.files)) ws.write(p, text);
        out.push(checkDefinition(pkg, { ...content, checks: { [t.key]: { files: t.files, run: t.run } } }, { program, key: t.key, kind: accept, criteria: t.criteria, gates }));
        adopted.push({ from: t.from, to: t.to, criteria: t.criteria, dependency_boundary: boundary });
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
      ...(adoptRule && adopted.length > 0 ? { [adoptRule.field]: adopted } : {}),
    });
  }

  function correctionRun(pkg, ws, content) {
    const req = parse(pkg.files['change_request.json'], {}) ?? {};
    const open = Array.isArray(req.open_obligations) ? req.open_obligations : [];
    const named = new Set(open.flatMap((o) => [o.check_key, o.key, o.check].filter((x) => typeof x === 'string')));
    const corrections = content.corrections ?? {};
    const keys = Object.keys(corrections).filter((k) => named.has(k) || [...named].some((n) => n.endsWith(k)));
    // M6 slice 46: the design criteria's checks, from verifier.design_catalogue alone (SEAM.md §539).
    const design = designChecks(pkg, ws, content);
    if (design.length > 0 && keys.length === 0) return shapeResult(pkg, { summary: `the design criteria's checks: ${design.map((d) => d.key).join(', ')}`, proposal: { rationale: 'the approved design added criteria; their checks', requested_change_kind: 'tightening' } });
    // A design rehearsal whose package states no design criteria: nothing to write, said so (its judgement names the element).
    if (content.design && keys.length === 0) return shapeResult(pkg, { summary: 'no check written: the package states no design criteria', proposal: { rationale: 'no design criterion was stated to this run', requested_change_kind: 'tightening' } });
    // A correction that matches no open obligation fails loudly (M7 of the review): it never writes every correction.
    if (keys.length === 0) throw new Error(`rehearsal fake: no correction in the rehearsal's content matches the open obligations ${JSON.stringify([...named])}`);
    for (const k of keys) for (const [p, text] of Object.entries(corrections[k])) ws.write(p, text);
    return shapeResult(pkg, { summary: 'the checks the change obliges, corrected', proposal: { rationale: 'the specification changed; the checks it names now read the new text', requested_change_kind: 'tightening' } });
  }

  // ---- the Builder (its stage, from its package) -----------------------------------------------

  function builderRun(pkg, ws, content) {
    const R = pkg.reads;
    const tasks = R['builder.tasks'];
    const impl = R['builder.implements'];
    const deps = R['builder.dependency_interfaces'];
    const obligations = R['builder.integration_obligations'];
    const named = tasks && Array.isArray(tasks.tasks) ? [...new Set(tasks.tasks.flatMap((t) => [...String(t).matchAll(/`([^`]+)`/g)].map((m) => m[1])))] : [];
    // A task naming a directory (a module's path, `web/`) is each file of the content under it.
    const paths = [...new Set(named.flatMap((p) => (p.endsWith('/') ? Object.keys(content.code ?? {}).filter((k) => k.startsWith(p)) : [p])))];
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
      // An integration obligation the code must keep (builder.integration_obligations):
      // "<file> listens on <host>:$<VAR>" becomes the listen call; without the obligation, a marker.
      body = body.replace(/\{\{obligation:listen\}\}/g, () => {
        const o = (obligations && Array.isArray(obligations.integration_obligations) ? obligations.integration_obligations : []).map((x) => /listens on ([\d.]+):\$(\w+)/.exec(String(x))).find(Boolean);
        return o ? `listen(Number(process.env.${o[2]}), '${o[1]}')` : 'MISSING-OBLIGATION-listen()';
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

  // ---- the Designer (M6 slice 46; M537 (b), (c); SEAM.md §539) ----------------------------------
  //
  // The design tree written ONLY from the package's `designer.*` blocks
  // (SEAM.md §538): the inventory it is drawn against, the schemas of the
  // files (a file is written only where its schema is stated, its objects
  // pruned to the schema's fields), the conventions each target requires,
  // the layouts, the mockup kinds each capability admits and how a
  // simulation is declared, the selection's defaults, the pinned-URL
  // allowlist, the ratio the contrast reason states, the criterion
  // catalogue. What a model writes and no package states (the colours, the
  // type, the convention values, the criteria the owner wants with their
  // paths, a library, a logo proposal) is CONTENT.design. Each turn rewrites
  // the whole design (the files it owns removed first); the engine's
  // inventory and placeholders are never touched but for the logo proposal
  // in the manifest.

  const DESIGN_ROOT = '.surety/design/';
  const OWNED = ['design.json', 'tokens.json', 'flows.json', 'screens.json', 'navigation.json', 'criteria.json', 'mockups'];
  const sub = (tpl, vars) => String(tpl ?? '').replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] === undefined ? `{{${k}}}` : String(vars[k])));
  const lum = (hex) => {
    const m = /^#([0-9a-fA-F]{6})$/.exec(String(hex ?? ''));
    if (!m) return null;
    const c = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratioOf = (a, b) => {
    const la = lum(a);
    const lb = lum(b);
    return la === null || lb === null ? 0 : (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  const schemaFor = (R, rel) => ((R['designer.schemas'] && R['designer.schemas'].schemas) || []).find((x) => x && x.file === `${DESIGN_ROOT}${rel}`) || null;

  // The tokens: the palette, and each candidate colour chosen by the ratio
  // DESIGN_CONTRAST_BELOW_AA states; told no ratio, the first candidate.
  function tokensOf(R, d) {
    const reason = ((R['designer.check_reasons'] && R['designer.check_reasons'].reasons) || []).find((r) => r && r.code === 'DESIGN_CONTRAST_BELOW_AA');
    const ratio = reason && typeof reason.ratio === 'number' ? reason.ratio : null;
    const themes = {};
    for (const [theme, colours] of Object.entries(d.palette || {})) {
      themes[theme] = { ...colours };
      for (const [token, candidates] of Object.entries((d.contrast_candidates || {})[theme] || {})) {
        const pair = (d.pairs || []).find((p) => p.text === token);
        const bg = pair ? themes[theme][pair.background] : null;
        const fit = ratio === null ? null : candidates.find((c) => ratioOf(c, bg) >= ratio);
        themes[theme][token] = fit || candidates[0];
      }
    }
    return { unit: 'lu', themes, type: d.type || {}, space: d.space || {}, radius: d.radius || {}, duration: d.duration || {}, pairs: d.pairs || [] };
  }

  // The fixture path of an obligation from the inventory's list (a permission state reads its target's first interface's ok fixture).
  function fixtureOf(inv, o) {
    const iface = o.interface || ((inv.obligations || []).find((x) => x.target === o.target && x.interface) || {}).interface;
    const state = o.interface ? o.state : 'ok';
    const f = (inv.fixtures || []).find((x) => x.interface === iface && x.state === state);
    if (!f) return null;
    return f.path.startsWith(DESIGN_ROOT) ? f.path.slice(DESIGN_ROOT.length) : f.path;
  }

  // A screen's conventions: each its target requires (designer.conventions), its value the content's.
  function conventionsOf(R, inv, target, root, d) {
    const block = R['designer.conventions'];
    const e = block && Array.isArray(block.targets) ? block.targets.find((x) => x && x.target === target) : null;
    if (!e) return null;
    const v = d.conventions || {};
    const out = {};
    for (const r of e.required || []) {
      if (r === 'route|transient') out.route = v.route || '/';
      else if (r === 'back') {
        if (!root) out.back = v.back || 'exit';
      } else if (v[r] !== undefined) out[r] = v[r];
    }
    const perms = ((inv.targets || []).find((t) => t.target === target) || {}).permissions || [];
    if (e.if_permissions && perms.length > 0) out[e.if_permissions] = perms.map((permission) => ({ permission, prompt_when: d.permission_prompt_when, rationale: d.permission_rationale }));
    return out;
  }

  function designerTurn(pkg, ws, content) {
    const R = pkg.reads;
    const d = content.design || {};
    const invBlock = R['designer.inventory'];
    const inv = invBlock && invBlock.inventory ? invBlock.inventory : null;
    for (const f of OWNED) ws.remove(`${DESIGN_ROOT}${f}`);
    if (!inv) return shapeResult(pkg, { summary: 'no inventory', reply: 'I was not given the interface inventory, so I cannot draw the design.', artifact_changed: true });
    const layoutsOf = (target) => {
      const L = R['designer.layouts'];
      const e = L && Array.isArray(L.targets) ? L.targets.find((x) => x && x.target === target) : null;
      return e ? e.layouts : null;
    };
    const mk = R['designer.mockup_kinds'];
    const capOf = (target) => (((mk && mk.capabilities) || []).find((x) => x && x.target === target) || {}).preview_capability;
    // Screens: one per UI requirement and target, each with every obligation of its target.
    const screens = [];
    const flowSteps = [];
    const ifaces = new Map((inv.interfaces || []).map((i) => [i.name, i]));
    for (const i of inv.interfaces || []) flowSteps.push({ key: `F1.${flowSteps.length + 1}`, title: i.name, interfaces: [i.name] });
    let n = 0;
    const roots = new Map();
    for (const req of inv.ui_requirements || []) {
      for (const target of req.targets || []) {
        n += 1;
        const key = `S${n}`;
        const root = !roots.has(target);
        if (root) roots.set(target, key);
        const obligations = (inv.obligations || []).filter((o) => o.target === target);
        const used = [...new Set(obligations.map((o) => o.interface).filter(Boolean))];
        const inputs = [];
        for (const name of used) {
          const props = ((ifaces.get(name) || {}).request || {}).properties || {};
          for (const [prop, shape] of Object.entries(props)) inputs.push({ interface: name, property: prop, label: `${prop[0].toUpperCase()}${prop.slice(1)}${shape && shape.unit ? ` (${shape.unit})` : ''}`, ...(shape && shape.unit ? { unit: shape.unit } : {}) });
        }
        screens.push({
          key,
          target,
          title: d.title || 'Screen',
          flow_steps: flowSteps.filter((s) => used.includes(s.interfaces[0])).map((s) => s.key),
          requirements: [req.key],
          interfaces: used,
          states: obligations.map((o) => ({ obligation: o, fixture: fixtureOf(inv, o) })),
          layouts: layoutsOf(target) || undefined,
          inputs,
          conventions: conventionsOf(R, inv, target, root, d) || undefined,
        });
      }
    }
    // Mockups: the first HTML kind the target's capability admits; a simulation declared as the package says.
    const mockups = [];
    const allow = R['designer.external_urls'];
    const lib = d.library && allow && Array.isArray(allow.allowlist) && allow.allowlist.length > 0 ? `https://${allow.allowlist[0]}/npm/${d.library.name}@${d.library.version}/${d.library.file}` : null;
    for (const s of screens) {
      const cap = capOf(s.target);
      const admitted = mk && mk.by_capability ? mk.by_capability[cap] || [] : [];
      const kind = ['static_html', 'simulated_html'].find((k) => admitted.includes(k) && (k !== 'static_html' || s.target === 'web'));
      if (!kind) continue;
      const rel = `mockups/${s.target}/${s.key.toLowerCase()}.html`;
      const t = (inv.targets || []).find((x) => x.target === s.target) || {};
      const ff = (t.form_factors || [])[0];
      const sim = kind === 'simulated_html' && mk.simulation && mk.simulation.declares ? { [mk.simulation.declares]: { target: s.target, ...(ff ? { form_factor: ff } : {}), layout: (s.layouts || [])[0] } } : {};
      const html = [
        '<!doctype html>',
        '<html lang="en">',
        `<head><meta charset="utf-8"><title>${s.key} ${d.title || ''} (${s.target})</title>${lib ? `<link rel="stylesheet" href="${lib}">` : ''}<link rel="stylesheet" href="../../tokens.css"></head>`,
        '<body><main>',
        `<h1>${d.title || ''}</h1>`,
        ...s.states.map((st) => `<p data-state="${st.obligation.state}">${st.obligation.state}</p>`),
        ...s.inputs.map((i) => `<label>${i.label} <input name="${i.property}"></label>`),
        '</main></body>',
        '</html>',
        '',
      ].join('\n');
      ws.write(`${DESIGN_ROOT}${rel}`, html);
      for (const st of s.states) st.mockup = rel;
      mockups.push({ path: rel, kind, screens: [s.key], ...sim, external_urls: lib ? [lib] : [] });
    }
    // The selection: the defaults the package states; the layouts as the package states them.
    const sf = R['designer.selection_floor'];
    let selection;
    if (sf && sf.defaults) {
      const slots = new Map();
      for (const x of sf.defaults.slots || []) slots.set(x.kind, [...new Set([...(slots.get(x.kind) || []), ...(x.variants || [])])]);
      selection = { themes: sf.defaults.themes || [], slots: [...slots].map(([kind, variants]) => ({ kind, variants })), layouts: (inv.targets || []).map((t) => ({ target: t.target, layouts: layoutsOf(t.target) || [] })) };
    }
    // Criteria: each the owner wants where the catalogue applies it, its text from the content's template.
    const cat = R['designer.criterion_catalogue'];
    const criteria = [];
    for (const w of d.criteria || []) {
      const t = (inv.targets || []).find((x) => x.target === w.target);
      const e = cat && Array.isArray(cat.kinds) ? cat.kinds.find((k) => k && k.kind === w.kind) : null;
      if (!t || !e) continue;
      const tOk = e.targets === 'all' || (Array.isArray(e.targets) && e.targets.includes(w.target));
      const xOk = e.technologies === 'all' || (Array.isArray(e.technologies) && e.technologies.includes(t.ui_technology));
      if (!tOk || !xOk) continue;
      const req = (inv.ui_requirements || []).find((r) => (r.targets || []).includes(w.target));
      if (!req) continue;
      const paths = w.paths || [];
      criteria.push({
        requirement: req.key,
        text: sub((d.criterion_text || {})[w.kind], { module: t.module, path0: paths[0], path1: paths[1], paths: paths.join(', '), slot: w.slot, variant: w.variant }),
        kind: w.kind,
        targets: [w.target],
        ...(paths.length > 0 ? { paths } : {}),
        ...(w.slot ? { slot: w.slot, variant: w.variant } : {}),
      });
    }
    const conv = R['designer.conventions'];
    const human_tests = (inv.targets || []).map((t) => {
      const mine = screens.filter((s) => s.target === t.target);
      const nc = conv && Array.isArray(conv.targets) ? (conv.targets.find((x) => x && x.target === t.target) || {}).not_checkable_yet || [] : [];
      return {
        target: t.target,
        text: sub(d.human_test_text, { target: t.target, screens: mine.map((s) => s.key).join(', '), native: capOf(t.target) === 'native' ? '' : ', on an emulator or a device and not on the simulated preview' }),
        screens: mine.map((s) => s.key),
        not_checkable_yet: mine.flatMap((s) => nc.filter((c) => c !== 'permission_prompt' || (t.permissions || []).length > 0).map((convention) => ({ screen: s.key, convention }))),
      };
    });
    // The logo proposal, in the manifest the engine wrote (idempotent across turns), its status from the schema's enum.
    const manSchema = schemaFor(R, 'assets/manifest.json');
    const manifest = parse(ws.read(`${DESIGN_ROOT}assets/manifest.json`), null);
    const statusEnum = manSchema && manSchema.schema ? ((((manSchema.schema.properties || {}).slots || {}).items || {}).properties || {}).status : null;
    if (d.logo_svg && manifest && Array.isArray(manifest.slots) && statusEnum && Array.isArray(statusEnum.enum) && statusEnum.enum.includes('proposed')) {
      const digest = crypto.createHash('sha256').update(d.logo_svg).digest('hex');
      const slot = manifest.slots.find((x) => x.kind === 'logo');
      const full = slot ? (slot.variants || []).find((v) => v.name === 'full') : null;
      if (slot && full && full.digest !== digest) {
        ws.write(`${DESIGN_ROOT}assets/logo/proposed-full.svg`, d.logo_svg);
        slot.variants = slot.variants.map((v) => (v.name === 'full' ? { name: 'full', format: 'svg', transparency: v.transparency || 'any', file: 'assets/logo/proposed-full.svg', digest } : v));
        slot.slot_version += 1;
        slot.status = 'proposed';
        slot.provenance = 'designer';
        slot.status_since = 1;
        slot.history = [...(slot.history || []), { slot_version: slot.slot_version, design_version: 1, status: 'proposed', files: slot.variants.filter((v) => v.digest).map((v) => ({ variant: v.name, digest: v.digest })) }];
        manifest.version += 1;
        ws.write(`${DESIGN_ROOT}assets/manifest.json`, `${JSON.stringify(prune(manSchema.schema, manifest), null, 2)}\n`);
      }
    }
    // Each machine file written only where the package states its schema, pruned to it.
    const files = {
      'tokens.json': tokensOf(R, d),
      'flows.json': { flows: [{ key: 'F1', title: d.title || 'Flow', requirements: (inv.ui_requirements || []).map((r) => r.key), steps: flowSteps }] },
      'screens.json': { screens },
      'navigation.json': { targets: (inv.targets || []).map((t) => ({ target: t.target, entries: roots.has(t.target) ? [roots.get(t.target)] : [], edges: [] })) },
      'criteria.json': { criteria, human_tests },
    };
    const names = {};
    for (const [rel, value] of Object.entries(files)) {
      const s = schemaFor(R, rel);
      if (!s) continue;
      ws.write(`${DESIGN_ROOT}${rel}`, `${JSON.stringify(prune(s.schema, value), null, 2)}\n`);
      names[rel] = true;
    }
    const ds = schemaFor(R, 'design.json');
    if (ds) {
      const design = {
        version: 1,
        origin: 'intended',
        inventory_digest: inv.inventory_digest,
        selection,
        targets: (inv.targets || []).map((t) => ({ module: t.module, target: t.target, ui_technology: t.ui_technology, form_factors: t.form_factors || [], preview_capability: t.preview_capability, layouts: layoutsOf(t.target) || [] })),
        ...(inv.cross_platform ? { cross_platform: { targets: (inv.targets || []).map((t) => t.target), differences: [] } } : {}),
        tokens_file: names['tokens.json'] ? 'tokens.json' : undefined,
        flows_file: names['flows.json'] ? 'flows.json' : undefined,
        screens_file: names['screens.json'] ? 'screens.json' : undefined,
        navigation_file: names['navigation.json'] ? 'navigation.json' : undefined,
        criteria_file: names['criteria.json'] ? 'criteria.json' : undefined,
        assets_file: 'assets/manifest.json',
        mockups,
      };
      ws.write(`${DESIGN_ROOT}design.json`, `${JSON.stringify(prune(ds.schema, design), null, 2)}\n`);
    }
    ws.write(`${DESIGN_ROOT}design.md`, `# ${d.title || 'The design'}\n\nDrawn from the interface inventory ${inv.inventory_digest}.\n`);
    return shapeResult(pkg, { summary: 'the design written', reply: `The design is written: ${screens.length} screens, ${mockups.length} mockups, ${criteria.length} criteria.`, artifact_changed: true });
  }

  // Review mode (designer.review): a verdict per screen, each resting on the
  // evidence its package lists; a native screen not observed; every verdict
  // a proposal. A first design at Alpha draws the design too (D7 §10.6).
  function designerReviewTurn(pkg, ws, content) {
    const R = pkg.reads;
    const rv = R['designer.review'] || {};
    const review = parse(pkg.files['design/review.json'], {}) || {};
    const obs = parse(pkg.files['design/observations.json'], {}) || {};
    const approved = parse(pkg.files['design/approved/design.json'], null);
    const approvedScreens = parse(pkg.files['design/approved/screens.json'], { screens: [] }) || { screens: [] };
    if (review.first_design) designerTurn(pkg, ws, content);
    const screens = [];
    for (const o of obs.observations || []) screens.push({ target: o.target, key: o.screen, verdict: 'matches', observed_on: 'browser', evidence: [o.evidence], deltas: [] });
    for (const o of obs.not_observed || []) screens.push({ target: o.target, key: o.screen, verdict: 'not_observed', not_observed_reason: o.reason || 'no_native_runtime', evidence: [], deltas: [] });
    const owner = rv.owner || null;
    if (owner && Array.isArray(owner.evidence)) {
      const target = review.subject && review.subject.target;
      // observed_on as the element states it: the owner's word, {value, provenance: owner_reported} (the review's S4), or a bare value.
      const said = (owner.evidence[0] || {}).observed_on;
      const on = said && typeof said === 'object' ? said.value : said;
      for (const s of (approvedScreens.screens || []).filter((x) => x.target === target)) screens.push({ target, key: s.key, verdict: 'matches', observed_on: on || 'device', evidence: owner.evidence.map((e) => e.id), deltas: [] });
    }
    const n = ws.list(`${DESIGN_ROOT}reviews`).filter((x) => /^review-\d+\.json$/.test(x)).length + 1;
    const body = { ...(approved && approved.version ? { design_version: approved.version } : {}), subject: review.subject || {}, screens, revised_design: false, first_design: Boolean(review.first_design) };
    const s = schemaFor(R, 'reviews/review-<n>.json');
    ws.write(`${DESIGN_ROOT}reviews/review-${n}.json`, `${JSON.stringify(s ? prune(s.schema, body) : body, null, 2)}\n`);
    return shapeResult(pkg, { summary: 'the review written', reply: `Review ${n}: ${screens.length} screens; every verdict is a proposal for you to confirm.`, artifact_changed: true });
  }

  // A UI Builder (or an asset_updated fix) places each effective asset file
  // its package carries (design/effective-assets.json, SEAM.md §482) at its
  // declared path, or where CONTENT.asset_paths puts it for the stage's
  // target, and binds each; an asset_updated fix at the bound paths its
  // prompt lists. Returns the bindings, or null for a package with no design.
  function placeAssets(pkg, ws, content) {
    const eff = parse(pkg.files['design/effective-assets.json'], null);
    if (!Array.isArray(eff)) return null;
    const screens = (parse(pkg.files['design/screens.json'], { screens: [] }) || { screens: [] }).screens || [];
    const targets = [...new Set(screens.map((s) => s.target))];
    const bound = [...String(pkg.prompt).matchAll(/^- `([^`]+)` \((\w+), (copy|derived)\)$/gm)].map((m) => ({ path: m[1], target: m[2], form: m[3] }));
    // An asset_updated fix names the slot it updates ("updates the asset slot <slot>"); the
    // prompt lists each bound path with its target and form but not its variant, so the
    // variant at a bound path is the one CONTENT.asset_paths placed there (the Builder's own
    // placement), and nothing else is copied onto it.
    const updated = (/updates the asset slot (\S+) from/.exec(String(pkg.prompt)) || [])[1] || null;
    const variantAt = (b) => Object.entries((content.asset_paths || {})[b.target] || {}).find(([, p]) => p === b.path)?.[0] ?? null;
    const bindings = [];
    for (const e of eff) {
      if (bound.length > 0 && updated !== null && e.slot !== updated) continue;
      const places = bound.length > 0
        ? bound.filter((b) => variantAt(b) === `${e.slot}/${e.variant}`).map((b) => ({ target: b.target, path: b.path }))
        : targets.map((t) => ({ target: t, path: ((content.asset_paths || {})[t] || {})[`${e.slot}/${e.variant}`] || (targets.length === 1 ? e.declared_path : undefined) })).filter((x) => x.path);
      for (const pl of places) {
        if (!fs.existsSync(path.join(pkg.dir, e.path))) continue;
        ws.copyFrom(path.join(pkg.dir, e.path), pl.path);
        bindings.push({ slot: e.slot, variant: e.variant, target: pl.target, path: pl.path, form: 'copy' });
      }
    }
    return bindings;
  }

  // The design criteria's checks (verifier.design_catalogue): one acceptance
  // check per criterion, covering it, its program the CONTENT's for its kind
  // with the implemented paths the block names, reading a slot through the
  // member the block states. Returns the definitions written.
  function designChecks(pkg, ws, content) {
    const R = pkg.reads;
    const dc = R['verifier.design_catalogue'];
    if (!dc || !Array.isArray(dc.criteria)) return [];
    const kinds = R['verifier.kinds'];
    const accept = kinds && Array.isArray(kinds.criteria_kinds) && kinds.criteria_kinds.includes('acceptance') ? 'acceptance' : null;
    const floor = R['verifier.gate_kinds_floor'];
    const gates = floor && Array.isArray(floor.gate_kinds) ? floor.gate_kinds : ['stage'];
    const dir = definitionsDir(R);
    const program = programOf(R, null);
    const out = [];
    for (const c of dc.criteria) {
      const key = `design-${String(c.id).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      const tpl = (content.design_checks || {})[c.kind] || `// rehearsal design check {{criterion}} on {{paths}}\nprocess.exit(0);\n`;
      const body = { files: { [`.surety/checks/run/${key}.mjs`]: sub(tpl, { criterion: c.id, paths: (c.paths || []).join(' '), path0: (c.paths || [])[0], slot: c.slot, variant: c.variant }) }, run: [`.surety/checks/run/${key}.mjs`] };
      const { d, files } = checkDefinition(pkg, { ...content, checks: { [key]: body } }, { program, key, kind: accept, criteria: [c.id], gates });
      if (c.slot && dc.asset_inputs && dc.asset_inputs.member) d[dc.asset_inputs.member] = [{ slot: c.slot, variant: c.variant }];
      for (const [p, text] of Object.entries(files)) ws.write(p, text);
      ws.write(`${dir}${d.key}.json`, `${JSON.stringify(d, null, 2)}\n`);
      out.push(d);
    }
    return out;
  }

  // ---- dispatch ------------------------------------------------------------------------------

  function play({ context, workspace, content = {} }) {
    const pkg = readPackage(context);
    const ws = writer(workspace);
    ws.root = workspace;
    const role = pkg.manifest.role;
    const kind = pkg.manifest.kind;
    let result;
    if (kind === 'session' && role === 'designer') result = pkg.reads['designer.review'] ? designerReviewTurn(pkg, ws, content) : designerTurn(pkg, ws, content);
    else if (kind === 'session' && role === 'spec_writer') result = specWriterTurn(pkg, ws);
    else if (kind === 'session' && role === 'architect') result = architectTurn(pkg, ws);
    else if (kind === 'session') result = shapeResult(pkg, { summary: 'rehearsal', reply: 'Noted.', artifact_changed: false });
    else if (kind === 'replan') result = replanRun(pkg, ws, content);
    else if (kind === 'spec_change') result = specChangeRun(pkg, ws);
    else if (kind === 'check_authoring') result = authoringRun(pkg, ws, content);
    else if (kind === 'check_correction') result = correctionRun(pkg, ws, content);
    else if (kind === 'stage_build') {
      result = builderRun(pkg, ws, content);
      // M6 slice 46: a UI stage places the effective assets its package carries and binds them (SEAM.md §539).
      const bindings = placeAssets(pkg, ws, content);
      if (bindings && pkg.resultSchema && pkg.resultSchema.properties && 'asset_bindings' in pkg.resultSchema.properties) result.asset_bindings = bindings;
      // The approved tokens' CSS binding the package carries (design/tokens.css, for an HTML and
      // CSS target) placed where CONTENT.tokens_paths puts it for the stage's target.
      if (typeof pkg.files['design/tokens.css'] === 'string') {
        const screens = (parse(pkg.files['design/screens.json'], { screens: [] }) || { screens: [] }).screens || [];
        for (const t of [...new Set(screens.map((x) => x.target))]) {
          const dest = (content.tokens_paths || {})[t];
          if (dest) ws.copyFrom(path.join(pkg.dir, 'design/tokens.css'), dest);
        }
      }
    } else if (kind === 'fix' && pkg.files['design/effective-assets.json']) {
      const bindings = placeAssets(pkg, ws, content) || [];
      result = shapeResult(pkg, { summary: `the effective assets placed at ${bindings.length} bound paths`, asset_bindings: bindings });
    }
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
