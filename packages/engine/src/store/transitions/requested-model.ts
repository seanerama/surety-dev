// The model a run of a role requests, as dispatch records it (DECISIONS
// item 45; objection 232, the owner's rule of 2026-11-24: "Before I click an
// action that can incur model usage, show the requested model that dispatch
// will record for that role. Label the backend separately. If the provider
// later reports which model actually ran, preserve that as a separate
// fact."). One function, the single source for:
//   - dispatch (runs.ts claimDispatch: `runs.model_requested`, the receipt's
//     and the ledger's), given the backend it resolved;
//   - the prototype preparation approval's manifest and question
//     (prototype/brief.ts preparationManifest), and the dispatch check that
//     the approved model is still the one requested;
//   - the brief's role list (prototype/brief.ts briefFacts);
//   - the request-checks consequence text (projections.ts
//     authoringConsequence; DECISIONS item 43).
//
// `model`: the role's `model_<role>` policy key where set, the backend's own
// model only when it is not; a qualification attempt's backend keeps its
// model. `provider`: the backend the role resolves to now, labelled apart.
// What the provider reports having run is never this: it is the ledger's
// `model_observed` (and the run's), kept beside `model_requested`.

import { roleModel } from './settings.js';
import { type Resolution, resolveBackend } from './trust.js';
import type { Tx } from './tx.js';

type Db = Tx['db'];

// A dispatch's backend: as resolveBackend gives it, or a qualification
// attempt's (whose model is the attempt's own).
export type DispatchBackend = Resolution | { kind: 'attempt'; backend: string; version: string; model: string };

export interface RequestedModel {
  role: string;
  // The backend (provider) the role resolves to now.
  provider: string;
  // The model a run of the role requests: what dispatch records as
  // `model_requested`.
  model: string;
  // How the backend resolves now: a scripted backend, an active trust entry,
  // a qualification attempt, or refused (and why).
  resolution: 'scripted' | 'entry' | 'attempt' | 'refused';
  refusal: string | null;
  // The backend's own model (an active entry's, the scripted backend's, the
  // attempt's): what `model` selects, never named as the requested model.
  backend_model: string;
}

export function requestedModelOf(db: Db, project: string, role: string, backend?: DispatchBackend): RequestedModel {
  const b = backend ?? resolveBackend(db, { project, role, scripted: 'scripted' });
  const model = b.kind === 'attempt' ? b.model : (roleModel(db, project, role) ?? b.model);
  return { role, provider: b.backend, model, resolution: b.kind, refusal: b.kind === 'refused' ? b.reason : null, backend_model: b.model };
}
