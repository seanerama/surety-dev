// The elements each role package states of what the engine reads from that
// role's products (E87 item 10; E135; BS5 §3, §12; row M442): the ids, their
// titles and the packages that carry them. The data are
// src/packages/reads.ts's, written from the parsers' and gates' own
// constants; this module holds only the names, so that the test seam can
// validate an omission without importing the packages
// (`--harness-package-omit`; GET /v1/harness/package-elements).

const SPEC_FORMS = [
  'spec_writer.header_fields',
  'spec_writer.requirement_form',
  'spec_writer.marks',
  'spec_writer.question_form',
  'spec_writer.index_columns',
  'spec_writer.module_table',
  'spec_writer.environment_fields',
  'spec_writer.sensitive_areas',
  'spec_writer.tier_table',
] as const;
const ARCHITECT = ['architect.schema.modules', 'architect.schema.roadmap', 'architect.schema.phase_plan', 'architect.schema.adr', 'architect.plan_reasons', 'architect.routing'] as const;
const VERIFIER = ['verifier.kinds', 'verifier.gate_kinds_floor', 'verifier.requires', 'verifier.covers', 'verifier.secrets', 'verifier.post_deploy'] as const;

export const PACKAGE_ELEMENTS = Object.freeze({
  // The Spec Writer's session, and its retrofit variant.
  spec_writer: [...SPEC_FORMS, 'spec_writer.approval_blockers'] as const,
  spec_writer_retrofit: [...SPEC_FORMS, 'spec_writer.approval_blockers', 'spec_writer.claims_table'] as const,
  // The Spec Writer's one-shot run on a specification change: the same file
  // in the same forms.
  spec_change: [...SPEC_FORMS, 'spec_writer.change_result'] as const,
  // The Architect's session (and its retrofit variant) and the replan one-shot.
  architect: [...ARCHITECT] as const,
  architect_retrofit: [...ARCHITECT] as const,
  replan: [...ARCHITECT] as const,
  // A retrofit replan may ask for the criteria of descriptive requirements (D6 §8.3, B.7).
  replan_retrofit: [...ARCHITECT, 'architect.spec_change_requests'] as const,
  // The Verifier: the correction package (D3's), the phase-authoring
  // package (N04) and its retrofit variant (B13).
  verifier_correction: [...VERIFIER] as const,
  verifier_authoring: [...VERIFIER, 'verifier.authoring_result', 'verifier.toolchain'] as const,
  verifier_authoring_retrofit: [...VERIFIER, 'verifier.authoring_result', 'verifier.toolchain', 'verifier.adoption_rule'] as const,
  // The phase's verification (D6 §5.8): its sign-off.
  phase_verification: ['verifier.phase_signoff'] as const,
  // The Builder of a stage.
  builder: ['builder.tasks', 'builder.implements', 'builder.integration_obligations', 'builder.dependency_interfaces'] as const,
} satisfies Record<string, readonly string[]>);

export type PackageName = keyof typeof PACKAGE_ELEMENTS;
export type ElementId = (typeof PACKAGE_ELEMENTS)[PackageName][number];

export const ELEMENT_TITLES: Readonly<Record<ElementId, string>> = Object.freeze({
  'spec_writer.header_fields': "The specification's header",
  'spec_writer.requirement_form': 'Each requirement (section 4)',
  'spec_writer.marks': 'The marks of a requirement with no criteria',
  'spec_writer.question_form': 'Open questions (section 10)',
  'spec_writer.index_columns': 'The requirement index (section 5)',
  'spec_writer.module_table': 'Modules (section 6)',
  'spec_writer.environment_fields': 'Environments (section 7)',
  'spec_writer.sensitive_areas': 'The closed list of sensitive areas',
  'spec_writer.tier_table': 'The tiers',
  'spec_writer.approval_blockers': "What blocks the owner's approval",
  'spec_writer.claims_table': 'Claims and reality (section 12)',
  'spec_writer.change_result': 'Your result: the changes you propose',
  'architect.schema.modules': 'The module map (B.3)',
  'architect.schema.roadmap': 'The roadmap (B.4)',
  'architect.schema.phase_plan': 'The phase plan (B.5)',
  'architect.schema.adr': 'An ADR (B.6)',
  'architect.plan_reasons': 'The mechanical plan check',
  'architect.routing': 'How a plan is routed',
  'architect.spec_change_requests': 'Asking for the criteria of descriptive requirements',
  'verifier.kinds': "A check's kind",
  'verifier.gate_kinds_floor': "A check's gate kinds and the tier's kind floor",
  'verifier.requires': "A check's requires",
  'verifier.covers': 'What a check covers',
  'verifier.secrets': "A check's secrets",
  'verifier.post_deploy': 'Checks against a deployed environment',
  'verifier.authoring_result': 'Your result: governed changes and deferrals',
  'verifier.toolchain': "The governed file and the toolchain your checks run under",
  'verifier.adoption_rule': 'Adopting an existing test',
  'verifier.phase_signoff': "Signing the phase off",
  'builder.tasks': "The stage's tasks",
  'builder.implements': 'The requirements this stage implements',
  'builder.integration_obligations': 'Integration obligations',
  'builder.dependency_interfaces': 'The interfaces of the stages you depend on',
});

export const ELEMENT_IDS: readonly ElementId[] = Object.freeze(Object.keys(ELEMENT_TITLES) as ElementId[]);

// GET /v1/harness/package-elements: each element with its title and the
// packages that carry it.
export function elementListing(): { id: ElementId; title: string; packages: PackageName[] }[] {
  return ELEMENT_IDS.map((id) => ({
    id,
    title: ELEMENT_TITLES[id],
    packages: (Object.keys(PACKAGE_ELEMENTS) as PackageName[]).filter((p) => (PACKAGE_ELEMENTS[p] as readonly string[]).includes(id)),
  }));
}
