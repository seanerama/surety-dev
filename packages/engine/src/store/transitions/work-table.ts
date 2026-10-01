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
  'triage_accept',
  'export',
  'publish',
  'deploy',
  'rollback',
  'adoption_baseline',
  'conformance',
] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

const BUILD: WorkStatus[] = ['eligible', 'claimed', 'executing', 'integrating', 'integrated', 'verifying', 'complete'];
const RUN_ONLY: WorkStatus[] = ['eligible', 'claimed', 'executing', 'complete'];
const INTEGRATE: WorkStatus[] = ['eligible', 'claimed', 'executing', 'integrating', 'integrated', 'complete'];
const DECIDE: WorkStatus[] = ['eligible', 'awaiting_decision', 'complete'];

export const KIND_PATHS: Record<WorkKind, readonly WorkStatus[]> = {
  stage_build: BUILD,
  fix: BUILD,
  verification: RUN_ONLY,
  review: RUN_ONLY,
  phase_verification: RUN_ONLY,
  check_correction: RUN_ONLY,
  replan: INTEGRATE,
  assessment: INTEGRATE,
  adoption_baseline: INTEGRATE,
  conformance: BUILD,
  spec_change: DECIDE,
  triage_accept: DECIDE,
  export: RUN_ONLY,
  publish: RUN_ONLY,
  deploy: RUN_ONLY,
  rollback: RUN_ONLY,
};

// The kinds M1 dispatches (build spec §3). Every other kind is refused before
// it becomes work and is never launched.
export const DISPATCHABLE: readonly WorkKind[] = ['stage_build', 'fix', 'verification', 'review', 'check_correction', 'replan', 'assessment'];

export const CONTINUATIONS: readonly WorkStatus[] = ['executing', 'integrating', 'verifying'];

// The statuses in which a run owns the work.
export const RUN_OWNING: readonly WorkStatus[] = ['claimed', 'executing', 'integrating', 'integrated', 'verifying', 'awaiting_decision'];

export type TemplateName = 'return' | 'park' | 'block' | 'continue' | 'stop' | 'abandon' | 'resume' | 'unpark' | 'cancel';

interface Template {
  from: readonly WorkStatus[];
  // null: the stored continuation (the `continue` template).
  to: WorkStatus | null;
  // Applies only to kinds whose path has this status.
  onlyKindsWith?: WorkStatus;
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
