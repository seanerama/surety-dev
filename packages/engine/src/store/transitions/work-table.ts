// The legal work-item transitions, held as data (D1 A.5 WorkItem; build spec
// §6 correction 11; Review B10). This is the only table: the transition
// function checks every status change against it, whoever asks for it.
//
// Each kind has its path. The common transitions are templates, applied to a
// kind only from the statuses that kind can reach (its path, or a status a
// template leads to from one) and for their named cause. Stop and Abandon
// apply only to kinds a run can own (their path has `claimed`), from every
// status in which a run owns the work, `integrated` and `awaiting_decision`
// included. Leaving `awaiting_decision` for executing, integrating or
// verifying is legal only back to the status the item stored on entering it.

export const WORK_STATUSES = [
  'eligible',
  'claimed',
  'executing',
  'integrating',
  'integrated',
  'verifying',
  'complete',
  'awaiting_decision',
  'held',
  'parked',
  'cancelled',
] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

export const WORK_KINDS = [
  'stage_build',
  'fix',
  'verification',
  'review',
  'phase_verification',
  'replan',
  'assessment',
  'spec_change',
  'check_correction',
  // D6 K7 (M5 slice 31): the phase's check authoring, as check_correction.
  'check_authoring',
  'triage_accept',
  'export',
  'publish',
  'deploy',
  'rollback',
  'adoption_baseline',
  'conformance',
  // Rapid prototype, slice E3 (R5): the Spec Writer's one-shot that
  // prepares a prototype's brief and its minimal specification.
  'brief_preparation',
] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

const BUILD: WorkStatus[] = ['eligible', 'claimed', 'executing', 'integrating', 'integrated', 'verifying', 'complete'];
const RUN_ONLY: WorkStatus[] = ['eligible', 'claimed', 'executing', 'complete'];
const INTEGRATE: WorkStatus[] = ['eligible', 'claimed', 'executing', 'integrating', 'integrated', 'complete'];
const DECIDE: WorkStatus[] = ['eligible', 'awaiting_decision', 'complete'];
// D6 A.5 (K8): a specification change's work runs the Spec Writer, then waits
// for the owner's decision on its proposal.
const PROPOSE: WorkStatus[] = ['eligible', 'claimed', 'executing', 'awaiting_decision', 'complete'];

export const KIND_PATHS: Record<WorkKind, readonly WorkStatus[]> = {
  stage_build: BUILD,
  fix: BUILD,
  verification: RUN_ONLY,
  review: RUN_ONLY,
  phase_verification: RUN_ONLY,
  check_correction: RUN_ONLY,
  check_authoring: RUN_ONLY,
  replan: INTEGRATE,
  assessment: INTEGRATE,
  adoption_baseline: INTEGRATE,
  conformance: BUILD,
  // Integrated as a replan is: its specification is committed onto the
  // integration branch, and its spec_approval raised (prototype/brief.ts).
  brief_preparation: INTEGRATE,
  spec_change: PROPOSE,
  triage_accept: DECIDE,
  export: RUN_ONLY,
  publish: RUN_ONLY,
  deploy: RUN_ONLY,
  rollback: RUN_ONLY,
};

// The kinds M1 dispatches (build spec §3). Every other kind is refused before
// it becomes work and is never launched.
// D6 (M5 slice 31b): the phase's verification and the specification change.
export const DISPATCHABLE: readonly WorkKind[] = ['stage_build', 'fix', 'verification', 'review', 'check_correction', 'check_authoring', 'replan', 'assessment', 'phase_verification', 'spec_change', 'brief_preparation'];

export const CONTINUATIONS: readonly WorkStatus[] = ['executing', 'integrating', 'verifying'];

// The statuses in which a run owns the work.
export const RUN_OWNING: readonly WorkStatus[] = ['claimed', 'executing', 'integrating', 'integrated', 'verifying', 'awaiting_decision'];

export type TemplateName = 'return' | 'park' | 'block' | 'continue' | 'stop' | 'abandon' | 'resume' | 'unpark' | 'cancel' | 'park_at_registration';

interface Template {
  from: readonly WorkStatus[];
  // null: the stored continuation (the `continue` template).
  to: WorkStatus | null;
  // Applies only to kinds whose path has this status.
  onlyKindsWith?: WorkStatus;
  // Applies only to the kinds listed, by name.
  onlyKinds?: readonly WorkKind[];
}

export const TEMPLATES: Record<TemplateName, Template> = {
  // A run that failed or was refused; the work is dispatched again later.
  return: { from: ['claimed', 'executing', 'integrating', 'verifying'], to: 'eligible' },
  // A limit was reached.
  park: { from: ['claimed', 'executing', 'integrating', 'verifying'], to: 'parked' },
  // A decision is needed before the work can go on; the status left is stored.
  block: { from: ['executing', 'integrating', 'verifying'], to: 'awaiting_decision' },
  // The decision was answered: back to the stored continuation only.
  continue: { from: ['awaiting_decision'], to: null },
  stop: { from: RUN_OWNING, to: 'held', onlyKindsWith: 'claimed' },
  // Abandon restores the recorded prior status, which in M1 is eligible.
  abandon: { from: RUN_OWNING, to: 'eligible', onlyKindsWith: 'claimed' },
  resume: { from: ['held'], to: 'eligible' },
  unpark: { from: ['parked'], to: 'eligible' },
  cancel: {
    from: ['eligible', 'claimed', 'executing', 'integrating', 'integrated', 'verifying', 'awaiting_decision', 'held', 'parked'],
    to: 'cancelled',
  },
  // H4's cap (E171 item 5 H4; E172; SEAM.md §554): a spec change's replan
  // registered again by the restale at the cap (a second staleness against
  // the same active generation, plan/replace.ts) is parked at registration
  // with blocker reason replan_restale_max, for the owner's retry or cancel;
  // no run, no claim. The one edge given to named kinds only.
  park_at_registration: { from: ['eligible'], to: 'parked', onlyKinds: ['replan'] },
};

export const TERMINAL: readonly WorkStatus[] = ['complete', 'cancelled'];

interface Edge {
  from: WorkStatus;
  to: WorkStatus;
}

// Every edge a kind may take: its path, then the templates applied to the
// statuses it can reach, until nothing new is reachable.
function edgesOf(kind: WorkKind): Edge[] {
  const path = KIND_PATHS[kind];
  const edges: Edge[] = [];
  const reach = new Set<WorkStatus>(path);
  const has = (from: WorkStatus, to: WorkStatus) => edges.some((e) => e.from === from && e.to === to);
  for (let i = 0; i + 1 < path.length; i++) edges.push({ from: path[i]!, to: path[i + 1]! });
  for (let grew = true; grew; ) {
    grew = false;
    for (const template of Object.values(TEMPLATES)) {
      if (template.onlyKindsWith !== undefined && !path.includes(template.onlyKindsWith)) continue;
      if (template.onlyKinds !== undefined && !template.onlyKinds.includes(kind)) continue;
      for (const from of template.from) {
        if (!reach.has(from)) continue;
        const targets = template.to === null ? CONTINUATIONS.filter((c) => path.includes(c)) : [template.to];
        for (const to of targets) {
          if (has(from, to)) continue;
          edges.push({ from, to });
          reach.add(to);
          grew = true;
        }
      }
    }
  }
  return edges;
}

const EDGES = new Map<WorkKind, Edge[]>(WORK_KINDS.map((k) => [k, edgesOf(k)]));

export const isWorkKind = (value: unknown): value is WorkKind => typeof value === 'string' && (WORK_KINDS as readonly string[]).includes(value);
export const isWorkStatus = (value: unknown): value is WorkStatus => typeof value === 'string' && (WORK_STATUSES as readonly string[]).includes(value);

// Is from → to legal for an item of this kind that stored `continuation`?
export function isLegalWorkEdge(kind: WorkKind, from: WorkStatus, to: WorkStatus, continuation: WorkStatus | null): boolean {
  if (!EDGES.get(kind)!.some((e) => e.from === from && e.to === to)) return false;
  if (from === 'awaiting_decision' && CONTINUATIONS.includes(to)) return to === continuation;
  return true;
}
