// The executable contract (Plan M73; RN §3; D1 §11.2, D1-38; SEAM.md §94): the
// engine's contract stated as one JSON document, computed from what the
// engine executes. The schema comes from applying the engine's own migrations
// to a real SQLite database; the closed enumerations from the CHECK
// constraints of that schema and from the engine's own constants; the
// transition tables, decision kinds, event owners and configuration from the
// tables the engine checks every change against. Nothing here is copied from
// D1's hand-written Appendix A, which the contract replaces.

import Database from 'better-sqlite3';

import {
  DECISION_KINDS,
  DECISION_TARGET_DEFAULTS,
  DECISION_TARGET_RANGE,
  DECISION_KINDS_WITHOUT_TARGET,
  ENGINE_BOOLEANS,
  ENGINE_FIXED,
  ENGINE_KEYS,
  ENGINE_AT_LEAST,
  ENGINE_NUMBERS,
  PROJECT_OPTIONS,
  PROJECT_POLICY,
} from '../config/schema.js';
import { DEFAULT_MIGRATIONS_DIR } from '../paths.js';
import { migrate } from '../store/migrate.js';
import { FRESHNESS, NOW_STATES, PROVENANCE } from '../store/projections.js';
import { OBSERVED_CONDITIONS } from '../store/transitions/environments.js';
import { EVENT_OWNERS, EVENT_TYPES } from '../store/transitions/event-types.js';
import { LIFECYCLES } from '../store/transitions/lifecycle.js';
import { KINDS, MANIFEST_KEYS } from '../store/transitions/queue.js';
import { ROLE_OF } from '../store/transitions/runs.js';
import { CONTINUATIONS, DISPATCHABLE, KIND_PATHS, RUN_OWNING, TEMPLATES, TERMINAL, WORK_KINDS, WORK_STATUSES } from '../store/transitions/work-table.js';

export interface FieldSpec {
  required: boolean;
  enum?: string;
  references?: string;
}

export interface ContractDocument {
  contract_version: number;
  enums: Record<string, string[]>;
  tables: Record<string, { fields: Record<string, FieldSpec> }>;
  work_items: Record<string, unknown>;
  transitions: Record<string, string[][]>;
  decisions: Record<string, Record<string, unknown>>;
  events: Record<string, { owner?: string; reserved?: boolean }>;
  config: { engine: Record<string, Record<string, unknown>>; project: Record<string, Record<string, unknown>> };
}

// ---- the schema of a real store ------------------------------------------------------

export interface RealColumn {
  name: string;
  required: boolean;
  references: string | null;
  // The values a CHECK (column IN (...)) constraint allows, if it has one of
  // string literals.
  values: string[] | null;
}

export type RealSchema = Map<string, RealColumn[]>;

const quoted = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function checkValues(sql: string, column: string): string[] | null {
  const re = new RegExp(`CHECK\\s*\\(\\s*"?${escapeRe(column)}"?\\s+IN\\s*\\(([^)]*)\\)`, 'i');
  const m = re.exec(sql);
  if (!m) return null;
  const items = m[1]!.split(',').map((item) => item.trim());
  if (items.length === 0 || !items.every((item) => /^'[^']*'$/.test(item))) return null;
  return items.map((item) => item.slice(1, -1));
}

// The tables, columns, foreign keys and CHECK enumerations the engine's
// migrations create, read from a database they were applied to.
export function realSchema(migrationsDir: string = DEFAULT_MIGRATIONS_DIR): RealSchema {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    migrate(db, migrationsDir);
    const schema: RealSchema = new Map();
    const tables = db.prepare(`SELECT "name", "sql" FROM sqlite_master WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%' ORDER BY "name"`).all() as { name: string; sql: string }[];
    for (const { name, sql } of tables) {
      const info = db.prepare(`PRAGMA table_info(${quoted(name)})`).all() as { name: string; notnull: number; pk: number }[];
      const keys = db.prepare(`PRAGMA foreign_key_list(${quoted(name)})`).all() as { from: string; table: string }[];
      schema.set(
        name,
        info.map((c) => ({
          name: c.name,
          required: c.notnull === 1 || c.pk > 0,
          references: keys.find((k) => k.from === c.name)?.table ?? null,
          values: checkValues(sql, c.name),
        })),
      );
    }
    return schema;
  } finally {
    db.close();
  }
}

// ---- enumerations -----------------------------------------------------------------------

// The name of the closed enumeration each constrained column holds (D1 A.2's
// names where it has one). The values are the schema's own.
const COLUMN_ENUMS: Record<string, string> = {
  'projects.tier': 'Tier',
  'modules.tier_override': 'Tier',
  'checks.tier_floor': 'Tier',
  'projects.baseline_state': 'BaselineState',
  'projects.prior_baseline_state': 'BaselineState',
  'projects.registration_state': 'RegistrationState',
  'work_items.kind': 'WorkItemKind',
  'work_items.status': 'WorkItemStatus',
  'work_items.prior_status': 'WorkItemStatus',
  'work_items.continuation': 'WorkContinuation',
  'runs.role': 'Role',
  'ledger_rows.role': 'Role',
  'runs.kind': 'RunKind',
  'runs.state': 'RunState',
  'runs.session_state': 'SessionState',
  'runs.outcome': 'RunOutcome',
  'runs.reason_class': 'RunReasonClass',
  'execution_domains.status': 'DomainStatus',
  'invocation_status_observations.status': 'InvocationStatus',
  'usage_observations.semantics': 'UsageSemantics',
  'ledger_rows.cost_status': 'CostStatus',
  'operations.kind': 'OperationKind',
  'operations.status': 'OperationStatus',
  'operation_attempts.status': 'AttemptStatus',
  'git_journal_events.journal_kind': 'JournalKind',
  'git_journal_state.journal_kind': 'JournalKind',
  'git_journal_events.event_kind': 'JournalEventKind',
  'git_journal_state.state': 'JournalState',
  'events.actor_kind': 'ActorKind',
  'stages.status': 'StageStatus',
  'workspaces.disposition': 'WorkspaceDisposition',
  'leases.resource_kind': 'LeaseKind',
  'decisions.kind': 'DecisionKind',
  'decisions.status': 'DecisionStatus',
  'ref_registry.kind': 'RefKind',
  'managed_checkouts.kind': 'CheckoutKind',
  'revisions.kind': 'RevisionKind',
  'candidates.nominated_by': 'NominatedBy',
  'candidates.progress': 'CandidateProgress',
  'out_of_band_changes.subject_kind': 'IntegritySubject',
  'out_of_band_changes.disposition': 'OobDisposition',
  'records.kind': 'RecordKind',
  'records.post_scan': 'PostScan',
  'protected_versions.change_kind': 'ProtectedChangeKind',
  'protected_proposals.requested_change_kind': 'ProtectedChangeKind',
  'protected_proposals.classified_change_kind': 'ProtectedChangeKind',
  'protected_versions.approver_authority': 'Authority',
  'protected_proposals.approver_authority': 'Authority',
  'findings.disposition_authority': 'Authority',
  'protected_proposals.proposed_by': 'ProposedBy',
  'protected_proposals.status': 'ProposalStatus',
  'checks.kind': 'CheckKind',
  'checks.runner_class': 'RunnerClass',
  'check_results.runner_class': 'RunnerClass',
  'scope_approvals.kind': 'ScopeApprovalKind',
  'acceptance_scopes.gate_kind': 'GateKind',
  'gate_evaluations.gate_kind': 'GateKind',
  'gate_evaluations.outcome': 'GateOutcome',
  'deployment_authorizations.status': 'AuthorizationStatus',
  'findings.scope': 'FindingScope',
  'findings.category': 'FindingCategory',
  'findings.proposed_severity': 'Severity',
  'findings.effective_severity': 'Severity',
  'findings.status': 'FindingStatus',
  'findings.disposition': 'Disposition',
  'applicability_assessments.status': 'AssessmentStatus',
  'signoffs.scope': 'SignOffScope',
  'effect_intents.status': 'IntentStatus',
  'notification_intents.status': 'NotificationStatus',
  // D2 A.2.
  'host_qualifications.status': 'HostQualificationStatus',
  'qualification_attempts.status': 'QualificationAttemptStatus',
  'qualification_attempts.auth_mode': 'AuthMode',
  'trust_entries.auth_mode': 'AuthMode',
  'trust_entries.mode': 'TrustMode',
  'trust_entries.status': 'TrustStatus',
  'trust_entries.isolation': 'IsolationMechanism',
  'trust_entries.boundary': 'BoundaryMechanism',
  'trust_entries.usage_granularity': 'UsageGranularity',
  'trust_entries.usage_semantics': 'UsageSemantics',
  'trust_entries.cost_reporting': 'CostReporting',
  'trust_entries.result_channel': 'ResultChannel',
  'execution_domains.profile': 'SandboxProfile',
  'execution_domains.launch_state': 'LaunchState',
  'execution_domains.observation': 'DomainObservation',
  'invocation_status_observations.exit_class': 'ExitClass',
  'execution_domains.exit_class': 'ExitClass',
};

const pascal = (text: string): string =>
  text
    .split(/[_.]/)
    .filter((part) => part !== '')
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join('');

// The enumeration a constrained column holds: its declared name, or one made
// from the table and column, so that no closed set goes undeclared.
export function enumNameOf(table: string, column: string): string {
  return COLUMN_ENUMS[`${table}.${column}`] ?? `${pascal(table)}${pascal(column)}`;
}

// Enumerations the engine holds in code rather than in a CHECK constraint.
const CODE_ENUMS: Record<string, readonly string[]> = {
  EventType: EVENT_TYPES,
  EngineMode: ['restricted', 'full'],
  NowState: NOW_STATES,
  ObservedCondition: OBSERVED_CONDITIONS,
  Freshness: FRESHNESS,
  Provenance: PROVENANCE,
};

// ---- the document ---------------------------------------------------------------------------

function configSection(): ContractDocument['config'] {
  const engine: Record<string, Record<string, unknown>> = {};
  for (const key of ENGINE_KEYS) {
    const number = ENGINE_NUMBERS[key];
    if (number) engine[key] = { default: number.default, min: number.min, max: number.max, integer: number.integer, ...(ENGINE_AT_LEAST[key] ? { at_least: ENGINE_AT_LEAST[key] } : {}) };
    else if (ENGINE_FIXED[key] !== undefined) engine[key] = { default: ENGINE_FIXED[key], fixed: true };
    else if (ENGINE_BOOLEANS[key] !== undefined) engine[key] = { default: ENGINE_BOOLEANS[key], type: 'boolean' };
    else if (key === 'api_authority') engine[key] = { default: '127.0.0.1:<api_port>', allowed: ['127.0.0.1:<api_port>', 'localhost:<api_port>'] };
    else if (key === 'decision_targets') {
      engine[key] = {
        default: {},
        value_min: DECISION_TARGET_RANGE.min,
        value_max: DECISION_TARGET_RANGE.max,
        not_overridable: [...DECISION_KINDS_WITHOUT_TARGET].sort(),
        effective_defaults: DECISION_TARGET_DEFAULTS,
      };
    }
  }
  const project: Record<string, Record<string, unknown>> = {};
  for (const [key, spec] of Object.entries(PROJECT_POLICY)) project[key] = { default: spec.default, min: spec.min, max: spec.max, integer: spec.integer };
  for (const [key, spec] of Object.entries(PROJECT_OPTIONS)) project[key] = { default: spec.default, type: spec.type, ...(spec.values ? { values: [...spec.values] } : {}), widening: spec.widening };
  return { engine, project };
}

// The contract of this engine.
export function exportContract(migrationsDir: string = DEFAULT_MIGRATIONS_DIR): ContractDocument {
  const schema = realSchema(migrationsDir);
  const enums: Record<string, string[]> = {};
  const tables: ContractDocument['tables'] = {};
  for (const [table, columns] of schema) {
    const fields: Record<string, FieldSpec> = {};
    for (const c of columns) {
      const field: FieldSpec = { required: c.required };
      if (c.values !== null) {
        const name = enumNameOf(table, c.name);
        enums[name] ??= c.values;
        field.enum = name;
      }
      if (c.references !== null) field.references = c.references;
      fields[c.name] = field;
    }
    tables[table] = { fields };
  }
  for (const [name, values] of Object.entries(CODE_ENUMS)) enums[name] = [...values];

  const templates: Record<string, Record<string, unknown>> = {};
  for (const [name, t] of Object.entries(TEMPLATES)) {
    templates[name] = { from: [...t.from], to: t.to, ...(t.onlyKindsWith !== undefined ? { only_kinds_with: t.onlyKindsWith } : {}) };
  }
  const kinds: Record<string, Record<string, unknown>> = {};
  for (const kind of WORK_KINDS) {
    const m1 = DISPATCHABLE.includes(kind);
    kinds[kind] = { m1, path: [...KIND_PATHS[kind]], ...(m1 && ROLE_OF[kind] ? { role: ROLE_OF[kind] } : {}) };
  }

  const decisions: ContractDocument['decisions'] = {};
  for (const kind of DECISION_KINDS) {
    const enabled = Object.prototype.hasOwnProperty.call(KINDS, kind);
    decisions[kind] = enabled
      ? { enabled: true, manifest: [...MANIFEST_KEYS[kind as keyof typeof MANIFEST_KEYS]], target_seconds: DECISION_TARGET_DEFAULTS[kind] ?? null }
      : { enabled: false };
  }

  const events: ContractDocument['events'] = {};
  for (const type of EVENT_TYPES) events[type] = { owner: EVENT_OWNERS[type] };

  const transitions: Record<string, string[][]> = {};
  for (const [name, edges] of Object.entries(LIFECYCLES)) transitions[name] = edges.map((edge) => [...edge]);

  return {
    contract_version: 1,
    enums,
    tables,
    work_items: {
      statuses: [...WORK_STATUSES],
      terminal: [...TERMINAL],
      kinds,
      templates,
      run_owning: [...RUN_OWNING],
      continuations: [...CONTINUATIONS],
    },
    transitions,
    decisions,
    events,
    config: configSection(),
  };
}
