// What the Designer's package and the Verifier's design additions state of
// what the engine reads (D7 §3.4, §8.4; E151; E135; BS6 §11.4, §12; row
// M537; SEAM.md §538), in src/packages/reads.ts's form: each element a gloss
// and a JSON value written from the design check's, the inventory's, the
// approval's and the assets' own constants (src/design/check.ts,
// inventory.ts, approval.ts, assets.ts, contrast.ts), never copied by hand.
// B.8 to B.16 are stated as closed JSON Schemas built from the check's
// field lists. Pure.

import { NOT_CHECKABLE_CONVENTIONS } from '../design/approval.js';
import { ASSET_FORMATS, ASSET_KINDS, ASSET_PROVENANCES, ASSET_STATUSES, ASSET_VARIANTS, TRANSPARENCIES } from '../design/assets.js';
import {
  CONVENTION_TARGETS,
  CRITERION_CATALOGUE,
  CSS_TECH,
  DELTA_KINDS,
  FIELDS,
  MOCKUP_KINDS,
  NATIVE_CONVENTIONS,
  NAV_KINDS,
  NEUTRAL_TOKEN_KINDS,
  NOT_OBSERVED,
  OBSERVED_ON,
  PACKAGING_STATUSES,
  REVIEW_FIELDS,
  REVIEW_VERDICTS,
  ROUTE_PATTERN,
  SUBJECT_KINDS,
} from '../design/check.js';
import { AA_RATIO } from '../design/contrast.js';
import { SPEC_MARKS } from '../spec/semantics.js';
import { INVENTORY_FILE, type Inventory, requiredConventions } from '../design/inventory.js';
import { B8, FORM_FACTORS, SHAPE_TYPES, TARGET_NAMES, UI_TECHNOLOGIES } from '../plan/schemas.js';
import { TURN_RESULT_SCHEMA } from '../sessions/package.js';
import type { ReadsElement } from './reads.js';

type Built = Partial<Record<ReadsElement['id'], ReadsElement | null>>;
type Schema = Record<string, unknown>;

const DESIGN_ROOT = '.surety/design/';
const file = (rel: string): string => `${DESIGN_ROOT}${rel}`;

// ---- JSON Schema helpers: every object with properties is closed --------------------------------

const closed = (properties: Record<string, Schema>, required: readonly string[] = [], description?: string): Schema => ({
  type: 'object',
  ...(description ? { description } : {}),
  ...(required.length > 0 ? { required: [...required] } : {}),
  additionalProperties: false,
  properties,
});
const list = (items: Schema, description?: string): Schema => ({ type: 'array', ...(description ? { description } : {}), items });
const str = (description?: string): Schema => ({ type: 'string', ...(description ? { description } : {}) });
const int = (description?: string): Schema => ({ type: 'integer', ...(description ? { description } : {}) });
const bool = (description?: string): Schema => ({ type: 'boolean', ...(description ? { description } : {}) });
const oneOf = (values: readonly (string | number)[], description?: string): Schema => ({ enum: [...values], ...(description ? { description } : {}) });
// A value the check does not read field by field: described, not shaped.
const free = (description: string): Schema => ({ description });
const layout: Schema = { type: ['integer', 'string'], description: 'a width in px (web), or <form factor>-<orientation> (android, ios)' };
const strings = (description?: string): Schema => list(str(), description);
// Each field of `fields` (the check's closed list), its schema from `of` or free.
function fieldsOf(fields: readonly string[], of: Record<string, Schema>, required: readonly string[] = [], description?: string): Schema {
  const properties: Record<string, Schema> = {};
  for (const f of fields) properties[f] = of[f] ?? free(f);
  return closed(properties, required, description);
}

const PREVIEW_CAPABILITIES = ['native', 'simulated', 'none'] as const;

const INVENTORY_FIELDS = ['inventory_digest', 'spec_version', 'architecture_version', 'targets', 'cross_platform', 'ui_requirements', 'interfaces', 'obligations', 'fixtures'] as const satisfies readonly (keyof Inventory)[];
const INVENTORY_TARGET_FIELDS = ['module', 'target', 'ui_technology', 'form_factors', 'preview_capability', 'layouts', 'required_conventions', 'permissions', 'required_slots', 'adrs', 'runtime'] as const satisfies readonly (keyof Inventory['targets'][number])[];
export const DESIGNER_FINDING_SCHEMA = closed(
  {
    category: oneOf(['requirement_conflict', 'contract_conflict', 'defect']),
    severity: oneOf(['critical', 'high', 'medium', 'low']),
    message: str(),
    interface: str('required on a contract_conflict: the interface it is about'),
    requirement: str('required on a requirement_conflict: the requirement it is about'),
  },
  ['category', 'severity', 'message'],
);
export const DESIGNER_FINDINGS_FIELD: Schema = list(DESIGNER_FINDING_SCHEMA, 'What you found the design cannot honour: a contract_conflict names its interface, a requirement_conflict its requirement (B.12).');

// The schemas, built on first use from the check's constants (no module
// cycle can see them half made).
let SCHEMAS: Record<string, Schema> | null = null;
function schemas(): Record<string, Schema> {
  if (SCHEMAS) return SCHEMAS;
  // B.8: an interface's shape (the Architect's; the inventory carries it).
  const SHAPE_SCHEMA = fieldsOf(B8.fields, {
    type: oneOf(SHAPE_TYPES),
    properties: { type: 'object', description: 'property name → shape (B.8)' },
    required: strings(),
    enum: { type: 'array', description: 'the allowed values' },
    minimum: { type: 'number' },
    maximum: { type: 'number' },
    minLength: int(),
    maxLength: int(),
    items: free('the shape of each item (B.8)'),
    collection: bool('true: a list the UI shows as a collection (an empty state is owed)'),
    unit: str('the unit an input of this property is labelled with'),
  });

  // B.9: the inventory, as the engine derives and commits it (read only).
  const INVENTORY_SCHEMA = fieldsOf(
    INVENTORY_FIELDS,
    {
      inventory_digest: str('the digest your design.json names'),
      spec_version: { type: ['integer', 'null'] },
      architecture_version: { type: ['integer', 'null'] },
      targets: list(
        fieldsOf(INVENTORY_TARGET_FIELDS, {
          module: str(),
          target: oneOf(TARGET_NAMES),
          ui_technology: oneOf(UI_TECHNOLOGIES),
          form_factors: list(oneOf(FORM_FACTORS)),
          preview_capability: oneOf(PREVIEW_CAPABILITIES),
          layouts: list(layout),
          required_conventions: strings('the conventions each screen of the target declares (designer.conventions)'),
          permissions: strings(),
          required_slots: list(closed({ kind: oneOf(ASSET_KINDS), variants: list(oneOf(ASSET_VARIANTS)) })),
          adrs: strings(),
          runtime: { type: ['string', 'null'] },
        }),
      ),
      cross_platform: bool(),
      ui_requirements: list(closed({ key: str(), phase: { type: ['integer', 'null'] }, modules: strings(), targets: list(oneOf(TARGET_NAMES)) })),
      interfaces: list(
        closed({
          name: str(),
          module: str(),
          kind: str(),
          path: str(),
          request: free('a B.8 shape'),
          response: free('a B.8 shape'),
          errors: list(closed({ code: str(), when: str() })),
          shape_known: bool(),
        }),
      ),
      obligations: list(closed({ target: oneOf(TARGET_NAMES), interface: str(), permission: str(), state: str() }, ['target', 'state'])),
      fixtures: list(closed({ interface: str(), state: str(), path: str() })),
    },
    INVENTORY_FIELDS,
    'The interface inventory (B.9): the engine derives and commits it; you read it and never change it.',
  );

  // B.10: design.json.
  const DESIGN_REQUIRED = FIELDS.design.filter((f) => f !== 'cross_platform');
  const DESIGN_SCHEMA = fieldsOf(
    FIELDS.design,
    {
      version: int('the design version, from 1'),
      origin: oneOf(['intended', 'observed']),
      inventory_digest: str("the inventory's inventory_digest, exactly"),
      selection: fieldsOf(FIELDS.selection, {
        themes: list(str(), 'the themes kept; at least one'),
        slots: list(closed({ kind: oneOf(ASSET_KINDS), variants: list(oneOf(ASSET_VARIANTS)) }, ['kind', 'variants'])),
        layouts: list(closed({ target: oneOf(TARGET_NAMES), layouts: list(layout) }, ['target', 'layouts'])),
      }),
      targets: list(
        fieldsOf(FIELDS.target, {
          module: str(),
          target: oneOf(TARGET_NAMES),
          ui_technology: oneOf(UI_TECHNOLOGIES),
          form_factors: list(oneOf(FORM_FACTORS)),
          preview_capability: oneOf(PREVIEW_CAPABILITIES),
          layouts: list(layout),
          window: free("a desktop target's window, as you declare it"),
        }),
      ),
      cross_platform: closed({
        targets: list(oneOf(TARGET_NAMES)),
        differences: list(closed({ target: oneOf(TARGET_NAMES), flow_step: str(), what: str(), why: str() }, ['target', 'what', 'why'])),
      }),
      tokens_file: str(),
      flows_file: str(),
      screens_file: str(),
      navigation_file: str(),
      criteria_file: str(),
      assets_file: str(),
      mockups: list(
        fieldsOf(
          FIELDS.mockup,
          {
            path: str('relative to .surety/design/'),
            kind: oneOf(MOCKUP_KINDS),
            screens: strings(),
            simulates: closed({ target: oneOf(TARGET_NAMES), form_factor: oneOf(FORM_FACTORS), layout }, ['target'], 'what a simulated_html mockup simulates'),
            external_urls: strings('each https://<allowed host>/…@<major>.<minor>.<patch>…'),
          },
          ['path', 'kind', 'screens'],
        ),
      ),
    },
    DESIGN_REQUIRED,
  );

  // B.11: tokens.json.
  const TOKENS_SCHEMA = fieldsOf(FIELDS.tokens, {
    unit: str('the logical unit of sizes'),
    themes: { type: 'object', description: 'theme → token name → colour (#rrggbb)' },
    type: free('the type scale'),
    space: free('the spacing scale'),
    radius: free('the radii'),
    duration: free('the durations, in ms'),
    pairs: list(closed({ text: str(), background: str() }, ['text', 'background']), 'every text-on-background pair; each must reach the contrast ratio in every selected theme'),
  });

  // B.12: flows.json, screens.json and the turn's result.
  const FLOWS_SCHEMA = fieldsOf(FIELDS.flows, {
    flows: list(fieldsOf(FIELDS.flow, { key: str(), title: str(), requirements: strings(), steps: list(fieldsOf(FIELDS.step, { key: str(), title: str(), requirement: str(), interfaces: strings() })) })),
  });
  const CONVENTIONS_SCHEMA = fieldsOf(
    FIELDS.conventions,
    {
      ...Object.fromEntries(FIELDS.conventions.map((c) => [c, free(`applies to ${Object.keys(CONVENTION_TARGETS).filter((t) => CONVENTION_TARGETS[t]!.includes(c)).join(', ')}`)])),
      // The one convention value the check reads by form (S3).
      route: { type: 'string', pattern: ROUTE_PATTERN.source, description: 'a request path: "/" then printable ASCII, no space or control (applies to web)' },
    },
    [],
    "the screen's conventions: only those of its target (designer.conventions)",
  );
  const SCREENS_SCHEMA = fieldsOf(FIELDS.screens, {
    screens: list(
      fieldsOf(
        FIELDS.screen,
        {
          key: str(),
          target: oneOf(TARGET_NAMES),
          title: str(),
          flow_steps: strings(),
          requirements: strings('UI requirements of the inventory on this target'),
          interfaces: strings(),
          states: list(fieldsOf(FIELDS.state, { obligation: free("an obligation of the inventory, as it lists it ({target, interface?, permission?, state})"), mockup: str(), fixture: str() })),
          layouts: list(layout),
          inputs: list(fieldsOf(FIELDS.input, { interface: str(), property: str(), label: str('names the unit where the property has one'), unit: str() })),
          conventions: CONVENTIONS_SCHEMA,
          notes: str(),
        },
        ['key', 'target', 'requirements', 'states', 'layouts', 'conventions'],
      ),
    ),
  });
  // B.13: criteria.json.
  const CRITERIA_SCHEMA = fieldsOf(FIELDS.criteria, {
    criteria: list(
      fieldsOf(
        FIELDS.criterion,
        {
          requirement: str('the UI requirement it adds a criterion to (R<n>), or "new"'),
          text: str(),
          kind: oneOf(Object.keys(CRITERION_CATALOGUE)),
          targets: list(oneOf(TARGET_NAMES)),
          paths: strings('the implemented paths the check reads'),
          width: int(),
          slot: str(),
          variant: oneOf(ASSET_VARIANTS),
        },
        ['requirement', 'text', 'kind', 'targets'],
      ),
    ),
    human_tests: list(
      fieldsOf(
        FIELDS.humanTest,
        {
          target: oneOf(TARGET_NAMES),
          text: str(),
          screens: strings(),
          not_checkable_yet: list(closed({ screen: str(), convention: oneOf(NATIVE_CONVENTIONS) }, ['screen', 'convention'])),
        },
        ['target', 'text', 'screens'],
      ),
    ),
  });

  // B.14: a review file.
  const REVIEW_SCHEMA = fieldsOf(
    REVIEW_FIELDS.file,
    {
      design_version: int('the design version reviewed'),
      subject: fieldsOf(REVIEW_FIELDS.subject, { kind: oneOf(SUBJECT_KINDS), candidate: str(), target: oneOf(TARGET_NAMES), build_ref: str() }, ['kind']),
      screens: list(
        fieldsOf(
          REVIEW_FIELDS.screen,
          {
            target: oneOf(TARGET_NAMES),
            key: str(),
            verdict: oneOf(REVIEW_VERDICTS),
            observed_on: oneOf(OBSERVED_ON),
            not_observed_reason: oneOf(NOT_OBSERVED),
            evidence: strings('evidence ids this review holds'),
            deltas: list(fieldsOf(REVIEW_FIELDS.delta, { state: str(), owner_words: str("the owner's words"), kind: oneOf(DELTA_KINDS) }, ['owner_words', 'kind'])),
          },
          ['target', 'key', 'verdict', 'evidence', 'deltas'],
        ),
      ),
      revised_design: bool(),
      first_design: bool(),
    },
    ['subject', 'screens', 'revised_design', 'first_design'],
    'Never a status: every verdict is a proposal the owner confirms.',
  );

  // B.15: navigation.json.
  const NAVIGATION_SCHEMA = fieldsOf(FIELDS.navigation, {
    targets: list(fieldsOf(FIELDS.navTarget, { target: oneOf(TARGET_NAMES), entries: strings('the root screens'), edges: list(fieldsOf(FIELDS.edge, { from: str(), to: str(), trigger: str(), kind: oneOf(NAV_KINDS) })) })),
  });

  // B.16: assets/manifest.json.
  const MANIFEST_SCHEMA = fieldsOf(FIELDS.manifest, {
    version: int('raised whenever the manifest changes'),
    slots: list(
      fieldsOf(FIELDS.slot, {
        key: str('a slug'),
        kind: oneOf(ASSET_KINDS),
        purpose: str(),
        platforms: list(oneOf(TARGET_NAMES)),
        placement: str(),
        screens: strings(),
        variants: list(
          fieldsOf(FIELDS.variant, {
            name: oneOf(ASSET_VARIANTS),
            format: oneOf(ASSET_FORMATS),
            size: closed({ w: int(), h: int() }),
            transparency: oneOf(TRANSPARENCIES),
            file: str('relative to .surety/design/'),
            digest: str('the sha256 of the file'),
          }),
        ),
        alt_text: str(),
        decorative: bool(),
        slot_version: int('raised whenever the slot\'s files change'),
        status: oneOf(ASSET_STATUSES, 'placeholder is the engine\'s; approved only by the owner\'s approval'),
        provenance: oneOf(ASSET_PROVENANCES),
        status_since: int(),
        history: list(free('{slot_version, design_version, status, files: [{variant, digest}]}')),
      }),
    ),
    packaging: list(fieldsOf(FIELDS.packaging, { target: oneOf(TARGET_NAMES), slot: str(), requirement: str(), guidance: fieldsOf(FIELDS.guidance, { source: str(), read_on: str() }), status: oneOf(PACKAGING_STATUSES) })),
  });
  SCHEMAS = { SHAPE_SCHEMA, INVENTORY_SCHEMA, DESIGN_SCHEMA, TOKENS_SCHEMA, FLOWS_SCHEMA, SCREENS_SCHEMA, CRITERIA_SCHEMA, REVIEW_SCHEMA, NAVIGATION_SCHEMA, MANIFEST_SCHEMA };
  return SCHEMAS;
}

// The Designer's turn result (B.12, beside B.7's).
export function designerTurnResultSchema(base: Schema): Schema {
  const properties = { ...((base.properties as Record<string, Schema>) ?? {}), findings: DESIGNER_FINDINGS_FIELD };
  return { ...base, properties };
}

// ---- the design check's reasons (D7 A.4, §5.6) ------------------------------------------------

export const designReasons = (): { code: string; clause: string; meaning: string; ratio?: number }[] => [
  { code: 'DESIGN_SCHEMA_INVALID', clause: '1', meaning: 'A design file is missing, is not JSON, or carries a field or a value outside its schema (designer.schemas).' },
  { code: 'DESIGN_INVENTORY_STALE', clause: '1', meaning: "design.json's inventory_digest is not the project's current inventory: draw against the inventory you are given." },
  { code: 'DESIGN_INVENTORY_MODIFIED', clause: '1', meaning: 'A file under inventory/ was changed: the inventory and its fixtures are the engine\'s; read them, never write them.' },
  { code: 'DESIGN_UNKNOWN_REQUIREMENT', clause: '2', meaning: 'A screen names a requirement that is not a UI requirement of its target in the inventory.' },
  { code: 'DESIGN_UNKNOWN_INTERFACE', clause: '2', meaning: 'A screen names an interface the inventory does not list.' },
  { code: 'DESIGN_UNKNOWN_TARGET', clause: '2', meaning: 'A screen or a target names a target (or a module and target) the inventory does not list.' },
  { code: 'DESIGN_MOCKUP_MISSING', clause: '2', meaning: 'A mockup, a fixture or a screen a design file names is not in the tree.' },
  { code: 'DESIGN_MOCKUP_ORPHAN', clause: '2', meaning: 'A mockup is listed for no screen, or a file under mockups/ is listed nowhere.' },
  { code: 'DESIGN_FIXTURE_INVALID', clause: '2', meaning: 'A fixture of your own under mockups/data/ is not valid against the shape the inventory\'s fixture of that name follows.' },
  { code: 'DESIGN_INTERFACE_SHAPE_UNKNOWN', clause: '2', meaning: 'A screen uses an interface whose shape the inventory lists as unknown: nothing is derived from it, and the owner settles it.' },
  { code: 'DESIGN_REQUIREMENT_UNCOVERED', clause: '3', meaning: 'A UI requirement of the inventory has no screen on one of its targets.' },
  { code: 'DESIGN_STATE_UNCOVERED', clause: '3', meaning: 'An obligation of the inventory (an interface state or a permission) is drawn by no screen of its target.' },
  { code: 'DESIGN_LAYOUT_UNCOVERED', clause: '3', meaning: 'A screen does not declare every selected layout of its target (designer.layouts).' },
  { code: 'DESIGN_INPUT_UNLABELLED', clause: '3', meaning: "An input of a property with a unit has no label naming that unit." },
  { code: 'DESIGN_NAV_UNKNOWN_SCREEN', clause: '4', meaning: "navigation.json names a screen that is not one of its target's screens." },
  { code: 'DESIGN_SCREEN_UNREACHABLE', clause: '4', meaning: "A screen cannot be reached from its target's entries by the navigation's edges." },
  { code: 'DESIGN_CONVENTION_UNDECLARED', clause: '4', meaning: 'A screen does not declare a convention its target requires (designer.conventions).' },
  { code: 'DESIGN_CONVENTION_UNKNOWN', clause: '4', meaning: 'A convention is declared unknown (retrofit, where the code cannot tell): shown, and blocking approval under before_build.' },
  { code: 'DESIGN_SHORTCUT_DUPLICATE', clause: '4', meaning: 'Two shortcuts of one screen use the same keys.' },
  { code: 'DESIGN_TARGET_DIVERGENCE_UNSTATED', clause: '4', meaning: 'In a cross-platform design a flow step has no screen on a target and no stated difference for it ({target, what, why}).' },
  { code: 'DESIGN_TOKEN_UNDEFINED', clause: '5', meaning: 'A declared pair names a token a selected theme does not define.' },
  { code: 'DESIGN_CONTRAST_BELOW_AA', clause: '5', meaning: 'A declared text-on-background pair is below the WCAG AA contrast ratio in a selected theme.', ratio: AA_RATIO },
  { code: 'DESIGN_AXIS_MISMATCH', clause: '6', meaning: "A target of design.json states a technology or a preview capability other than the inventory's." },
  { code: 'DESIGN_MOCKUP_KIND_MISMATCH', clause: '6', meaning: "A mockup's kind is not one its screen's target admits (designer.mockup_kinds)." },
  { code: 'DESIGN_SIMULATION_UNDECLARED', clause: '6', meaning: 'An HTML mockup of a non-web target is not simulated_html, or a simulated_html mockup does not declare what it simulates.' },
  { code: 'DESIGN_EXTERNAL_URL_UNPINNED', clause: '6', meaning: 'A mockup loads an external URL from a host outside the allowlist or not at an exact version (designer.external_urls).' },
  { code: 'DESIGN_CRITERION_UNCHECKABLE', clause: '7', meaning: 'A criterion is of no kind of the catalogue, or reads files and names no implemented paths.' },
  { code: 'DESIGN_CRITERION_NOT_APPLICABLE', clause: '7', meaning: "A criterion's kind does not apply to a target or technology it is scoped to; a native convention is recorded not_checkable_yet, never a criterion." },
  { code: 'DESIGN_INTERFACE_DISPUTED', clause: 'approval', meaning: 'A contract_conflict you raised on an interface is still open: the design is not approvable until the owner settles it.' },
  { code: 'DESIGN_ASSET_SLOT_MISSING', clause: '8', meaning: 'A selected slot or variant is not in the asset manifest.' },
  { code: 'DESIGN_ASSET_PLATFORM_UNKNOWN', clause: '8', meaning: "A slot names a platform that is not a target of the inventory." },
  { code: 'DESIGN_ASSET_PLACEMENT_MISSING', clause: '8', meaning: 'A banner, or an illustration with no screens, has no placement.' },
  { code: 'DESIGN_ASSET_ALT_MISSING', clause: '8', meaning: 'A logo, banner or illustration has no alt text.' },
  { code: 'DESIGN_ASSET_FILE_MISSING', clause: '8', meaning: 'A selected variant names no file, or the file it names is not in the tree.' },
  { code: 'DESIGN_ASSET_FORMAT_MISMATCH', clause: '8', meaning: "A file's bytes are not of its variant's declared format (read by its header)." },
  { code: 'DESIGN_ASSET_SIZE_MISMATCH', clause: '8', meaning: "A raster file's size, read from its header, is not its variant's declared size." },
  { code: 'DESIGN_ASSET_TRANSPARENCY_MISMATCH', clause: '8', meaning: "A raster file's transparency, read from its header, contradicts its variant's." },
  { code: 'DESIGN_ASSET_SVG_ACTIVE', clause: '8', meaning: 'An SVG carries a script, an event attribute, an animation or an external reference.' },
  { code: 'DESIGN_ASSET_STATUS_FORGED', clause: '8', meaning: "A slot is marked approved with files no owner's approval made effective, or placeholder by anyone but the engine." },
  { code: 'DESIGN_ASSET_VERSION_INVALID', clause: '8', meaning: "A slot's files changed and its slot_version did not rise, the manifest changed and its version did not rise, or a digest is not its file's." },
  { code: 'DESIGN_ASSET_SLOT_KEY_INVALID', clause: '8', meaning: 'A slot key is not a slug (a lower-case letter, then up to 63 lower-case letters, digits, _ or -).' },
  { code: 'DESIGN_SELECTION_BELOW_FLOOR', clause: '8', meaning: "The selection drops below the floor: every theme, the logo, a target's favicon or app icon, or every layout of a target (designer.selection_floor)." },
];

// ---- what each catalogue kind's check reads (§7.2) ------------------------------------------------

const CATALOGUE_READS: Record<string, string> = {
  tokens_only: 'the implemented stylesheets at its paths: every colour, size, spacing, radius and duration is a custom property of the CSS binding',
  layout_at_width: 'the implemented stylesheets at its paths: the layout declared at its width',
  label_with_unit: 'the implemented markup at its paths: every input labelled, with its unit where it has one',
  focus_visible: 'the implemented stylesheets at its paths: a visible focus style kept on every focusable element',
  reduced_motion: 'the implemented stylesheets at its paths: motion reduced under prefers-reduced-motion',
  token_parity: 'the implemented tokens at its paths (the CSS binding, or where the code reads the neutral tokens.json outside HTML and CSS) against the approved tokens',
  contrast_aa: 'the implemented tokens at its paths: every declared pair at the AA ratio',
  state_marker_present: "the implemented markup or source at its paths: each state of its screens carries its marker",
  asset_parity: 'the implemented file at its path against the effective slot and variant, byte for byte (copy) or by derivation',
  human: 'nothing: a person judges it (a human-test requirement)',
};

const catalogueKinds = (): { kind: string; targets: string[] | 'all'; technologies: string[] | 'all'; reads: string }[] =>
  Object.entries(CRITERION_CATALOGUE).map(([kind, c]) => ({ kind, targets: c.targets === 'all' ? 'all' : [...c.targets], technologies: c.technologies === 'all' ? 'all' : [...c.technologies], reads: CATALOGUE_READS[kind] ?? 'the implemented paths it names' }));

// ---- the Designer's elements -----------------------------------------------------------------------

export interface DesignerReadsFacts {
  // The project's current inventory, as recorded and committed; null when
  // it cannot be read (the element is then not stated).
  inventory: Inventory | null;
  inventory_digest: string | null;
  widths: number[];
  orientations: string[];
  allowlist: string[];
}

export function designerElements(f: DesignerReadsFacts | null): Built {
  if (f === null) return {};
  const inv = f.inventory;
  const targets = inv?.targets ?? [];
  // With no inventory, what depends on it is unknown, never empty (N1).
  const noInventory = { unknown: 'the project has no interface inventory yet' };
  const perTarget = <T>(make: () => T): T | typeof noInventory => (inv ? make() : noInventory);
  const out: Built = {};
  if (inv) {
    out['designer.inventory'] = {
      id: 'designer.inventory',
      gloss: 'Draw against this inventory: name its inventory_digest in design.json; cover every UI requirement on each of its targets and every obligation (a state of an interface, a permission) with its fixture. It is the engine\'s: read it, never change it.',
      data: { file: INVENTORY_FILE, inventory_digest: f.inventory_digest ?? inv.inventory_digest, inventory: inv },
    };
  }
  out['designer.schemas'] = {
    id: 'designer.schemas',
    gloss: 'Each file of the design tree in exactly this JSON Schema: closed objects, no other field, these values (B.8 to B.16). Your turn result follows the turn_result schema (result-schema.json).',
    data: {
      schemas: [
        { id: 'B.8', name: 'shape', schema: schemas().SHAPE_SCHEMA! },
        { id: 'B.9', file: INVENTORY_FILE, read_only: true, schema: schemas().INVENTORY_SCHEMA! },
        { id: 'B.10', file: file('design.json'), schema: schemas().DESIGN_SCHEMA! },
        { id: 'B.11', file: file('tokens.json'), schema: schemas().TOKENS_SCHEMA! },
        { id: 'B.12', file: file('flows.json'), schema: schemas().FLOWS_SCHEMA! },
        { id: 'B.12', file: file('screens.json'), schema: schemas().SCREENS_SCHEMA! },
        { id: 'B.12', name: 'turn_result', schema: designerTurnResultSchema(TURN_RESULT_SCHEMA) },
        { id: 'B.13', file: file('criteria.json'), schema: schemas().CRITERIA_SCHEMA! },
        { id: 'B.14', file: file('reviews/review-<n>.json'), schema: schemas().REVIEW_SCHEMA! },
        { id: 'B.15', file: file('navigation.json'), schema: schemas().NAVIGATION_SCHEMA! },
        { id: 'B.16', file: file('assets/manifest.json'), schema: schemas().MANIFEST_SCHEMA! },
      ],
    },
  };
  out['designer.check_reasons'] = {
    id: 'designer.check_reasons',
    gloss: 'The design check runs at every save and at close; each of these refuses the save (its clause of D7 §5.6) until you correct it. It reads JSON, SVG as text and raster files by their headers; it runs nothing you write.',
    data: { reasons: designReasons().map((r) => ({ code: r.code, clause: r.clause, meaning: r.meaning, ...(r.ratio !== undefined ? { ratio: r.ratio } : {}) })) },
  };
  out['designer.conventions'] = {
    id: 'designer.conventions',
    gloss: "Each screen declares, in its conventions, every convention its target requires, and only conventions of its target (`route|transient`: either field; `back` is not owed on a root screen; `permissions`, one entry per permission of the target, only where it has one). What only a running build shows is not checkable yet: recorded for a person, never a criterion.",
    data: {
      reason: 'DESIGN_CONVENTION_UNDECLARED',
      targets: TARGET_NAMES.map((t) => {
        const withPerm = requiredConventions(t, true);
        const without = requiredConventions(t, false);
        const ifPermissions = withPerm.filter((c) => !without.includes(c));
        return { target: t, fields: [...(CONVENTION_TARGETS[t] ?? [])], required: without, ...(ifPermissions.length > 0 ? { if_permissions: ifPermissions[0] } : {}), not_checkable_yet: [...(NOT_CHECKABLE_CONVENTIONS[t] ?? [])] };
      }),
      route: { field: 'route', type: 'string', pattern: ROUTE_PATTERN.source, rule: 'a web screen\'s route is a request path the engine may ask the service for: "/" then printable ASCII, no space or control (DESIGN_SCHEMA_INVALID otherwise)' },
      cross_platform: { difference: ['target', 'what', 'why'], reason: 'DESIGN_TARGET_DIVERGENCE_UNSTATED', rule: "In a cross-platform design every flow step has a screen on every target, or design.json's cross_platform.differences states, per target, what differs and why." },
    },
  };
  out['designer.criterion_catalogue'] = {
    id: 'designer.criterion_catalogue',
    gloss: "A design criterion (criteria.json) is of one of these kinds, scoped to the targets and technologies the kind applies to; the engine's checks read what each kind reads. A native convention is never a criterion: it is not checkable yet.",
    data: {
      kinds: catalogueKinds(),
      native_conventions: [...NATIVE_CONVENTIONS],
      not_applicable: 'DESIGN_CRITERION_NOT_APPLICABLE',
      hint: 'not_checkable_yet',
      paths_rule: `A criterion of a kind that reads files names the implemented paths it reads (paths); ${NEUTRAL_TOKEN_KINDS.join(' and ')} outside ${CSS_TECH.join(' and ')} apply only with paths naming where the code reads the neutral tokens.json.`,
    },
  };
  out['designer.mockup_kinds'] = {
    id: 'designer.mockup_kinds',
    gloss: "Each screen has a mockup of a kind its target's preview capability admits. A web target with HTML and CSS is shown natively; any other target is shown as a labelled simulation.",
    data: {
      kinds: [
        { kind: 'static_html', what: 'an HTML page of a web screen', targets: ['web'], capability: 'native' },
        { kind: 'scene_html', what: 'an HTML page of a web scene', targets: ['web'], technologies: ['three_js'], capability: 'any: admitted for a web target whose technology is three_js' },
        { kind: 'simulated_html', what: 'an HTML drawing of a non-web screen, declared a simulation', capability: 'simulated' },
        { kind: 'image', what: 'an image of the screen', capability: 'any' },
        { kind: 'source_stub', what: 'a source file of the screen, never run', capability: 'any' },
      ],
      by_capability: { native: ['static_html', 'scene_html', 'image', 'source_stub'], simulated: ['simulated_html', 'image', 'source_stub'], none: ['image', 'source_stub'] },
      simulation: {
        kind: 'simulated_html',
        declares: 'simulates',
        reason: 'DESIGN_SIMULATION_UNDECLARED',
        rule: "An HTML mockup of a non-web target is a simulation and must be declared one: a mockup of a non-web screen is simulated_html, image or source_stub, and a simulated_html mockup's simulates names its target (simulates.target; a form factor and a layout may follow, unchecked). It is never the native behaviour.",
      },
      capabilities: perTarget(() => targets.map((t) => ({ module: t.module, target: t.target, preview_capability: t.preview_capability }))),
    },
  };
  out['designer.selection_floor'] = {
    id: 'designer.selection_floor',
    gloss: "design.json's selection starts from these defaults. You may narrow it, never below the floor; a narrowing is the owner's to accept at design_approval.",
    data: {
      defaults: perTarget(() => ({
        themes: ['light', 'dark'],
        // Per target, as the inventory derives them.
        slots: targets.flatMap((t) => t.required_slots.map((s) => ({ target: t.target, kind: s.kind, variants: [...s.variants] }))),
        // The same defaults in design.json's own selection shape (per kind,
        // the union over the targets; the layouts per target): written as
        // it is, it narrows nothing.
        selection: {
          themes: ['light', 'dark'],
          slots: [...new Set(targets.flatMap((t) => t.required_slots.map((s) => s.kind)))].map((kind) => ({ kind, variants: [...new Set(targets.flatMap((t) => t.required_slots.filter((s) => s.kind === kind).flatMap((s) => s.variants)))] })),
          layouts: targets.map((t) => ({ target: t.target, layouts: [...t.layouts] })),
        },
      })),
      floor: { themes: 1, layouts_per_target: 1, logo_variants: 1, per_target: perTarget(() => targets.map((t) => ({ target: t.target, kind: t.target === 'web' ? 'favicon' : 'app_icon', variants: 1 }))) },
      reason: 'DESIGN_SELECTION_BELOW_FLOOR',
      narrowing: 'Each theme, slot variant or layout the selection leaves out of the defaults is listed as a narrowing in the design approval; the owner accepts it by approving.',
    },
  };
  out['designer.external_urls'] = {
    id: 'designer.external_urls',
    gloss: "A mockup may load a library only from an allowed host, at an exact version, and lists every such URL in its external_urls.",
    data: {
      field: 'external_urls',
      allowlist: [...f.allowlist],
      version_pattern: '@<major>.<minor>.<patch>',
      reason: 'DESIGN_EXTERNAL_URL_UNPINNED',
      rule: `Every URL a mockup lists in its external_urls has its host in the allowlist (the project's design_external_urls${f.allowlist.length === 0 ? ': none, so no external URL is allowed' : ''}) and holds an exact version, @<major>.<minor>.<patch>; the check reads the list, not the mockup's markup.`,
    },
  };
  out['designer.layouts'] = {
    id: 'designer.layouts',
    gloss: "Each screen declares every selected layout of its target. These are the layouts the inventory derived from the project's widths and orientations.",
    data: {
      targets: perTarget(() => targets.map((t) => ({ module: t.module, target: t.target, layouts: [...t.layouts] }))),
      widths: [...f.widths],
      orientations: [...f.orientations],
      rule: "Every screen declares every selected layout of its target in its layouts (DESIGN_LAYOUT_UNCOVERED); web's are the widths, android's and ios's each form factor in each orientation, a desktop target's none until you declare its window.",
    },
  };
  return out;
}

// The review mode's element (D7 §10.2, §10.5): what the package holds, the
// provenances, the owner's items labelled.
export interface DesignerReviewFacts {
  owner: { build_ref: string | null; evidence: { id: string; name: string | null; format: string | null; observed_on: string | null; file?: string }[] } | null;
  observations: Record<string, unknown>[];
  // Which of the mode's files this package holds (the slice-46 review's S4).
  present: { approved: boolean; source: boolean };
}
export function designerReviewElement(f: DesignerReviewFacts): Built {
  return {
    'designer.review': {
      id: 'designer.review',
      gloss: 'A review session: what the package holds of the build, where each item came from, and what you write (B.14). Every verdict is a proposal; the owner confirms it.',
      data: {
        // The files this package holds; null for one its mode does not have
        // (an owner-invoked review has no engine observation, a review at
        // Alpha no owner evidence; no approved design, no UI source).
        files: {
          review: 'design/review.json',
          approved: f.present.approved ? 'design/approved/' : null,
          source: f.present.source ? 'design/source/' : null,
          check_results: 'design/check-results.json',
          observations: f.owner ? null : 'design/observations.json',
          evidence: f.owner ? 'design/evidence.json' : null,
        },
        provenance: {
          engine_observed: 'the engine fetched it itself from the running service (a web screen with a route), and recorded the bytes',
          owner_supplied: 'the owner supplied the file (a screenshot or a recording) as evidence; the engine checked its header, never its content',
          owner_reported: 'the owner said it (the build he names, what he saw); nothing verified it',
        },
        verdicts: 'Your verdicts are proposals the owner confirms (design_verdicts); never write a status.',
        simulation: 'A verdict on a simulation (observed_on simulation) is never evidence about the native build.',
        owner: f.owner
          ? {
              build_ref: { value: f.owner.build_ref, provenance: 'owner_reported' },
              // The file is the owner's (owner_supplied); where he says he saw it is his word (owner_reported).
              evidence: f.owner.evidence.map((e) => ({
                id: e.id,
                name: e.name,
                provenance: 'owner_supplied',
                format: e.format,
                observed_on: e.observed_on === null ? null : { value: e.observed_on, provenance: 'owner_reported' },
                ...(e.file ? { file: e.file } : {}),
              })),
            }
          : null,
        observations: f.observations,
      },
    },
  };
}

// The retrofit mode's element (D7 §12).
export function designerRetrofitElement(uiSource: string[]): Built {
  return {
    'designer.retrofit': {
      id: 'designer.retrofit',
      gloss: 'Retrofit: describe the adopted UI as the code shows it before you prescribe; its source is under design/source/, read only.',
      data: {
        origin: 'observed',
        ui_source: [...uiSource],
        reasons: ['DESIGN_CONVENTION_UNKNOWN', 'DESIGN_INTERFACE_SHAPE_UNKNOWN'],
        assets: { provenance: 'observed', status: 'proposed' },
        criteria: 'Criteria you propose go through the consolidated specification change; they are scheduled to the first change phase, never to the conformance set.',
      },
    },
  };
}

// ---- the Verifier's design catalogue (D7 §7.2, §8.4) ----------------------------------------------

export interface DesignCatalogueFacts {
  // The design criteria of the specification with their implemented paths,
  // [] when no design is approved.
  criteria: { id: string; kind: string; targets: string[]; technologies?: string[]; paths: string[]; slot?: string; variant?: string }[];
  // The approved design's criteria its approval could not map to a
  // specification id (criterion-map.ts), stated, never omitted.
  unmatched?: { index: number; requirement: string; kind: string; text: string; why: string }[];
  // The design criteria of kind `human` (D7 §7.2, §7.3): a person judges
  // them through the target's human test; no check is written or owed.
  judged_by_person?: string[];
  // The programs the governed file's check_commands names, which a
  // definition's command names first; null when the governed values cannot
  // be read (unknown, never none).
  programs?: string[] | null;
}
export function verifierDesignElements(f: DesignCatalogueFacts | null): Built {
  if (f === null) return {};
  return {
    'verifier.design_catalogue': {
      id: 'verifier.design_catalogue',
      gloss:
        "Each design criterion needs a required acceptance check covering it, of a criteria kind, reading what its catalogue kind reads at the implemented paths it names, except a criterion of kind human (judged_by_person): a person judges it through its target's human test, so write no check for it and leave it out of deferred_criteria; no gate waits on a check of it. A check of a slot reads the effective file through asset_inputs, given to it at the variable named, never the file in the repository alone.",
      data: {
        kinds: catalogueKinds(),
        criteria: f.criteria,
        unmatched: f.unmatched ?? [],
        judged_by_person: f.judged_by_person ?? [],
        command: {
          member: 'command',
          programs: f.programs ?? null,
          rule: "A design check's command names one of these programs first, by its name, never a path (the governed file's check_commands); its program file is under the protected root.",
        },
        asset_inputs: { member: 'asset_inputs', item: { slot: '<slot key>', variant: '<variant>' }, variable: 'SURETY_ASSET_<SLOT>_<VARIANT>' },
      },
    },
  };
}

// ---- the design batch's specification change (D7 §7.1, §7.3) --------------------------------------

export interface DesignChangeFacts {
  criteria: Record<string, unknown>[];
  human_tests: (Record<string, unknown> & { phase: number | null; phase_reason?: string })[];
}
export function designChangeElements(f: DesignChangeFacts | null): Built {
  if (f === null) return {};
  return {
    'spec_writer.design_change': {
      id: 'spec_writer.design_change',
      gloss:
        "This change writes an approved design's criteria and human tests into the specification (D7 §7.1, §7.3), in the forms above. The owner approves it with the design, as one batch.",
      data: {
        source: 'design',
        criteria: f.criteria,
        human_tests: f.human_tests,
        criterion: {
          under: 'its requirement; a criterion whose requirement is "new" is a requirement of its own',
          id: 'R<n>.<m>, the next free number under its requirement; no existing key changes',
          text: "the criterion's text exactly as given: the engine finds each design criterion in the specification by its text",
          change_kind: 'criteria_added',
        },
        human_test: {
          key: 'a new requirement, the next free R<n>, one per human test',
          surface: `${SPEC_MARKS.surface} (<target>)`,
          mark: SPEC_MARKS.human_test,
          text: "the human test's text, after the mark; no criteria",
          phase: "its Phase in the index: the human test's phase above (the phase that holds the target's last UI stage); empty where it is null, phase_reason saying why",
          change_kind: 'added',
        },
      },
    },
  };
}
