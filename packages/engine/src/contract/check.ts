// The contract checker (Plan M73; Review N02, B17; SEAM.md §94). Two kinds of
// check, and every finding says which and where:
//
//   - lexical: every name the document uses is declared (a state of a
//     transition, a path or a template is a value of its enumeration; a
//     field's enumeration is declared; a reference names a declared table; a
//     decision kind and an event type are values of their enumerations);
//   - structural: the declarations are true and complete (the tables are
//     those the engine's migrations create in a real SQLite database, column
//     by column, with their foreign keys, NOT NULL and CHECK enumerations; an
//     enabled decision kind has its manifest; every event type is owned or
//     reserved).
//
// A clean result certifies neither lifecycle path nor route behaviour: those
// are the acceptance rows' to show, and the result says so.

import { type RealSchema, realSchema } from './document.js';

export interface Finding {
  check: 'lexical' | 'structural';
  path: (string | number)[];
  message: string;
}

export interface CheckResult {
  valid: boolean;
  findings: Finding[];
  checked: string[];
  not_checked: string[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

export function checkContract(doc: unknown, schema: RealSchema = realSchema()): CheckResult {
  const findings: Finding[] = [];
  const lexical = (path: (string | number)[], message: string) => findings.push({ check: 'lexical', path, message });
  const structural = (path: (string | number)[], message: string) => findings.push({ check: 'structural', path, message });
  const done = (): CheckResult => ({
    valid: findings.length === 0,
    findings,
    checked: ['lexical', 'structural'],
    not_checked: ['lifecycle_traces', 'route_behaviour'],
  });

  if (!isObj(doc)) {
    structural([], 'The contract is not a JSON object.');
    return done();
  }
  for (const section of ['enums', 'tables', 'work_items', 'transitions', 'decisions', 'events', 'config']) {
    if (!isObj(doc[section])) structural([section], `The section "${section}" is missing or is not an object.`);
  }

  // ---- enumerations ----
  const enums = new Map<string, string[]>();
  if (isObj(doc.enums)) {
    for (const [name, values] of Object.entries(doc.enums)) {
      if (!strings(values) || values.length === 0) {
        structural(['enums', name], `The enumeration ${name} is not a non-empty list of values.`);
        continue;
      }
      if (new Set(values).size !== values.length) structural(['enums', name], `The enumeration ${name} repeats a value.`);
      enums.set(name, values);
    }
  }
  const inEnum = (name: string, value: unknown): boolean => typeof value === 'string' && (enums.get(name)?.includes(value) ?? false);

  // ---- tables ----
  const tables = isObj(doc.tables) ? doc.tables : {};
  for (const [table, spec] of Object.entries(tables)) {
    const fields = isObj(spec) && isObj(spec.fields) ? spec.fields : null;
    if (fields === null) {
      structural(['tables', table], `The table ${table} declares no fields.`);
      continue;
    }
    for (const [field, f] of Object.entries(fields)) {
      const path = ['tables', table, 'fields', field];
      if (!isObj(f)) {
        structural(path, `The field ${table}.${field} is not an object.`);
        continue;
      }
      if (f.enum !== undefined && (typeof f.enum !== 'string' || !enums.has(f.enum))) lexical(path, `${table}.${field} is said to be of the enumeration ${String(f.enum)}, which is not declared.`);
      if (f.references !== undefined && (typeof f.references !== 'string' || !Object.prototype.hasOwnProperty.call(tables, f.references))) {
        lexical(path, `${table}.${field} is said to reference ${String(f.references)}, which is not a declared table.`);
      }
    }
  }
  // Structural: the tables are those of a real store, exactly.
  for (const [table, columns] of schema) {
    const spec = tables[table];
    if (!isObj(spec) || !isObj(spec.fields)) {
      structural(['tables', table], `The store has the table ${table}, and the contract does not declare it.`);
      continue;
    }
    const fields = spec.fields;
    for (const c of columns) {
      const path = ['tables', table, 'fields', c.name];
      const f = fields[c.name];
      if (!isObj(f)) {
        structural(path, `The store's table ${table} has the column ${c.name}, and the contract does not declare it.`);
        continue;
      }
      if (f.required !== c.required) structural(path, `${table}.${c.name} is ${c.required ? '' : 'not '}required in the store, and the contract says otherwise.`);
      const declared = typeof f.references === 'string' ? f.references : null;
      if (declared !== c.references) {
        structural(path, c.references === null ? `${table}.${c.name} references no table in the store, and the contract says it references ${declared}.` : `${table}.${c.name} references ${c.references} in the store, and the contract says ${declared ?? 'nothing'}.`);
      }
      if (c.values !== null) {
        if (typeof f.enum !== 'string') structural(path, `${table}.${c.name} is a closed enumeration in the store (${c.values.join(', ')}), and the contract declares none.`);
        else if (enums.has(f.enum)) {
          const values = enums.get(f.enum)!;
          if (values.length !== c.values.length || !values.every((v) => c.values!.includes(v))) {
            structural(path, `${table}.${c.name} allows ${c.values.join(', ')} in the store, and its enumeration ${f.enum} holds ${values.join(', ')}.`);
          }
        }
      } else if (typeof f.enum === 'string' && enums.has(f.enum)) {
        structural(path, `${table}.${c.name} is not a closed enumeration in the store, and the contract says it is of ${f.enum}.`);
      }
    }
    for (const field of Object.keys(fields)) {
      if (!columns.some((c) => c.name === field)) structural(['tables', table, 'fields', field], `The contract declares ${table}.${field}, and the store's table ${table} has no such column.`);
    }
  }
  for (const table of Object.keys(tables)) {
    if (!schema.has(table)) structural(['tables', table], `The contract declares the table ${table}, and the store has no such table.`);
  }

  // ---- work items ----
  const work = isObj(doc.work_items) ? doc.work_items : {};
  const status = (path: (string | number)[], value: unknown) => {
    if (!inEnum('WorkItemStatus', value)) lexical(path, `${JSON.stringify(value)} is not a WorkItemStatus.`);
  };
  for (const key of ['statuses', 'terminal', 'run_owning', 'continuations']) {
    const list = work[key];
    if (!Array.isArray(list)) structural(['work_items', key], `work_items.${key} is not a list.`);
    else list.forEach((value, i) => status(['work_items', key, i], value));
  }
  const kinds = isObj(work.kinds) ? work.kinds : {};
  if (!isObj(work.kinds)) structural(['work_items', 'kinds'], 'work_items.kinds is not an object.');
  for (const [kind, spec] of Object.entries(kinds)) {
    if (!inEnum('WorkItemKind', kind)) lexical(['work_items', 'kinds', kind], `${kind} is not a WorkItemKind.`);
    const path = isObj(spec) ? spec.path : undefined;
    if (!Array.isArray(path) || path.length < 2) {
      structural(['work_items', 'kinds', kind], `The work kind ${kind} has no path of two or more statuses.`);
      continue;
    }
    path.forEach((value, i) => status(['work_items', 'kinds', kind, 'path', i], value));
    if (typeof (spec as Obj).m1 !== 'boolean') structural(['work_items', 'kinds', kind, 'm1'], `Whether M1 dispatches ${kind} is not stated.`);
  }
  const templates = isObj(work.templates) ? work.templates : {};
  if (!isObj(work.templates)) structural(['work_items', 'templates'], 'work_items.templates is not an object.');
  for (const [name, t] of Object.entries(templates)) {
    if (!isObj(t) || !Array.isArray(t.from)) {
      structural(['work_items', 'templates', name], `The template ${name} has no "from" list.`);
      continue;
    }
    t.from.forEach((value, i) => status(['work_items', 'templates', name, 'from', i], value));
    if (t.to === null) {
      if (name !== 'continue') lexical(['work_items', 'templates', name, 'to'], `Only "continue" leads to the stored continuation; ${name} must name its status.`);
    } else status(['work_items', 'templates', name, 'to'], t.to);
    if (t.only_kinds_with !== undefined) status(['work_items', 'templates', name, 'only_kinds_with'], t.only_kinds_with);
  }

  // ---- transitions ----
  const transitions = isObj(doc.transitions) ? doc.transitions : {};
  for (const [name, chains] of Object.entries(transitions)) {
    if (!enums.has(name)) lexical(['transitions', name], `${name} is not a declared enumeration, so its states are undeclared.`);
    if (!Array.isArray(chains)) {
      structural(['transitions', name], `The transitions of ${name} are not a list of chains.`);
      continue;
    }
    chains.forEach((chain, i) => {
      if (!Array.isArray(chain) || chain.length < 2) {
        structural(['transitions', name, i], 'A chain has two or more states.');
        return;
      }
      chain.forEach((state, j) => {
        if (enums.has(name) && !inEnum(name, state)) lexical(['transitions', name, i, j], `${JSON.stringify(state)} is not a ${name}.`);
      });
    });
  }

  // ---- decisions ----
  const decisions = isObj(doc.decisions) ? doc.decisions : {};
  for (const [kind, spec] of Object.entries(decisions)) {
    if (!inEnum('DecisionKind', kind)) lexical(['decisions', kind], `${kind} is not a DecisionKind.`);
    if (!isObj(spec) || typeof spec.enabled !== 'boolean') {
      structural(['decisions', kind], `Whether the decision kind ${kind} is enabled is not stated.`);
      continue;
    }
    if (spec.enabled && (!strings(spec.manifest) || spec.manifest.length === 0)) structural(['decisions', kind], `The enabled decision kind ${kind} has no dependency manifest.`);
  }
  for (const kind of enums.get('DecisionKind') ?? []) {
    if (!Object.prototype.hasOwnProperty.call(decisions, kind)) structural(['decisions', kind], `The decision kind ${kind} is declared and the decisions section says nothing of it.`);
  }

  // ---- events ----
  const events = isObj(doc.events) ? doc.events : {};
  for (const [type, spec] of Object.entries(events)) {
    if (!inEnum('EventType', type)) lexical(['events', type], `${type} is not an EventType.`);
    const owned = isObj(spec) && typeof spec.owner === 'string' && spec.owner !== '';
    const reserved = isObj(spec) && spec.reserved === true;
    if (!owned && !reserved) structural(['events', type], `The event type ${type} has neither an owner that emits it nor the mark "reserved".`);
    if (owned && reserved) structural(['events', type], `The event type ${type} is both owned and reserved.`);
  }
  for (const type of enums.get('EventType') ?? []) {
    if (!Object.prototype.hasOwnProperty.call(events, type)) structural(['events', type], `The event type ${type} is declared and the events section says nothing of it.`);
  }

  // ---- configuration ----
  const config = isObj(doc.config) ? doc.config : {};
  for (const scope of ['engine', 'project']) {
    const keys = config[scope];
    if (!isObj(keys)) {
      structural(['config', scope], `config.${scope} is not an object.`);
      continue;
    }
    for (const [key, spec] of Object.entries(keys)) {
      if (!isObj(spec) || !('default' in spec)) structural(['config', scope, key], `${scope}.${key} states no default.`);
      else if (typeof spec.min === 'number' && typeof spec.max === 'number' && typeof spec.default === 'number' && (spec.default < spec.min || spec.default > spec.max || spec.min > spec.max)) {
        structural(['config', scope, key], `${scope}.${key}: the default ${spec.default} is not within ${spec.min} to ${spec.max}.`);
      }
    }
  }

  return done();
}
