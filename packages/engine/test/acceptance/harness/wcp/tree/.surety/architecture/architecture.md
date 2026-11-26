# Workshop Cut Planner — Architecture

**Architecture version:** 2
**Spec version:** 2
**Tier:** T1
**Targets:** web

## 1. Overview

A single-page browser application served by a dependency-free Node.js static file server. All planning logic, state and persistence live in the browser; the server only serves the files under `public/`. There is no build step, no package dependency and no external CDN (ADR-001). Lengths are kept in millimetres; a millimetres/inches selector changes only how lengths are entered and shown (ADR-003).

```
browser ──GET──▶ server.mjs ──▶ public/index.html, public/styles.css, public/js/*.mjs
   │
   └─ public/js/app.mjs (web-ui) ──uses──▶ planner.mjs (planner-core)
                                 ├─uses──▶ units.mjs   (units: parse / format mm <-> in)
                                 └─uses──▶ store.mjs   (plan-store) ──▶ localStorage["cutPlanner.plan"], ["cutPlanner.unit"]
```

## 2. Modules

| Module | Paths | Responsibility | Spec module |
| --- | --- | --- | --- |
| static-server | `server.mjs` | Serve `GET /` as `public/index.html` and other GET paths from `public/`; 404 otherwise; 405 for non-GET/HEAD; refuse path traversal. Port from `PORT`, default 8080. | Static server |
| planner-core | `public/js/planner.mjs` | Pure functions, no DOM: validation of numbers, expansion of pieces into instances, kerf arithmetic, placement (manual placements first, then first-fit decreasing), unplaced explanations, move checks. | Web client |
| plan-store | `public/js/store.mjs` | Load, save and clear the plan in `localStorage` under `cutPlanner.plan`, tolerating a missing or corrupt value; load and save the selected unit under `cutPlanner.unit`. | Web client |
| units | `public/js/units.mjs` | Pure functions, no DOM: parse a decimal length in the selected unit to millimetres, format millimetres for display in mm (≤ 2 decimals) or in (≤ 3 decimals), unit names and symbols (ADR-003). | Web client |
| web-ui | `public/index.html`, `public/styles.css`, `public/js/app.mjs` | Unit selector, input forms and lists in the selected unit, field messages, board bars to scale, unplaced list with add-board, move controls, clear-plan, print cut sheet and the print stylesheet. | Web client |
| tests | `tests/` | `node:test` unit tests of planner-core and plan-store, a smoke test of the server; acceptance checks of the UI. | Tests |

ES modules are loaded natively by the browser (`<script type="module" src="/js/app.mjs">`); `.mjs` is served as `text/javascript`.

## 3. Data model

The plan (the saved value, spec §9):

```json
{ "version": 1, "bladeMm": 3,
  "boards": [{ "id": "b1", "lengthMm": 2400 }],
  "pieces": [{ "id": "p1", "lengthMm": 800, "quantity": 3, "label": "" }],
  "placements": { "p1#2": "b1" } }
```

- Ids are generated client-side (`b<n>`, `p<n>`, never reused within the plan).
- A **piece instance** is one unit of a piece row: id `<pieceId>#<k>` for k = 1..quantity. `placements` maps instance ids to board ids and holds only manual placements made with the move control.
- All lengths are millimetres, possibly non-integer when entered in inches (inches × 25.4). The plan carries no unit; the selected unit is stored separately (§5, ADR-003).
- Only valid values reach the plan. A field holding an invalid value (zero, negative, non-numeric, non-integer quantity) shows a message next to it and the plan keeps its last valid value, so the layout never uses it (R1.4). A newly added row is only added once its values are valid.
- Removing a board drops the placements pointing at it; lowering a quantity drops placements of instances that no longer exist.

## 4. Planner core (ADR-002)

`computeLayout(plan) -> Layout`:

```
Layout = {
  bladeMm,
  boards: [{ boardId, lengthMm,
             segments: [{ kind: "piece", instanceId, pieceId, lengthMm, label, manual }
                       | { kind: "kerf", lengthMm }
                       | { kind: "offcut", lengthMm }],
             usedMm, freeMm }],
  unplaced: [{ instanceId, pieceId, lengthMm, label, reason }]
}
```

Kerf rule: on a board holding pieces p1..pk (in cutting order), one kerf of `bladeMm` lies between each adjacent pair; after pk, if `remainder = length − Σp − (k−1)·blade` is greater than zero, a final cut consumes `min(blade, remainder)` and the offcut is `remainder − that`. Hence segment lengths always sum to the board's length (R2.3), and three 800 mm pieces need 2406 mm (R3.1).

`fits(board, pieces, newLength, blade)`: true when `Σp + newLength + k·blade ≤ length` (k = pieces already on the board).

Placement order:
1. Manual placements, in plan order of instances: kept when the board exists and the piece fits; otherwise ignored (the instance falls through to step 2).
2. Remaining instances, sorted by length descending (ties in plan order), each on the first board in board-list order where it fits.
3. Anything left is unplaced.

Within a board, cutting order is longest first (ties in placement order).

Unplaced reasons (`reason` carries a machine code, its lengths in mm, and a sentence formatted in the unit passed as `computeLayout(plan, unit)`, default `"mm"`; the unit never affects placement):
- `TOO_LONG` — the piece is longer than every board: "Piece 3000 mm is longer than the longest board (2400 mm)." (R3.5); also used when there are no boards.
- `NO_ROOM` — for the board with the most free space: "These 3 pieces need 2406 mm (2400 mm of pieces plus 6 mm for 2 cuts) but the board is 2400 mm." — counting that board's pieces plus this one, with (n−1) cuts (R3.1). In inches each figure is converted from its own mm value: "These 3 pieces need 94.724 in (94.488 in of pieces plus 0.236 in for 2 cuts) but the board is 94.488 in." (R3.6).

`checkMove(plan, layout, instanceId, boardId, unit = "mm") -> { ok: true } | { ok: false, message }`: tests fit against the target board's current pieces excluding the moved instance; the refusal states the piece length, the kerf and the space left on that board in the selected unit (R3.4). `applyMove` returns a new plan with `placements[instanceId] = boardId`.

All functions are pure and return new objects; the UI re-renders from `computeLayout` on every change.

## 5. Plan store

- `loadUnit(storage)` returns `"in"` only when `cutPlanner.unit` holds `"in"`, else `"mm"` (missing, unrecognised, or storage throwing); `saveUnit(unit, storage)` writes it when the selector changes (R4.4, R4.5). A plan saved by iteration 1 has no unit key, so it opens unchanged in millimetres (R4.6). `clearPlan` keeps the unit.

- `loadPlan(storage = localStorage) -> Plan`: missing key, JSON parse error, wrong `version` or malformed shape returns the empty plan (`bladeMm` 3, no boards, no pieces, no placements) without throwing (R4.4); invalid entries are dropped.
- `savePlan(plan, storage)`: writes the JSON; called by the UI after every plan change (R4.1, R4.2).
- `clearPlan(storage)`: removes the key; the UI asks `confirm()` first, then resets to the empty plan and saves it (R4.3).
- A storage exception (quota, disabled storage) is caught and shown as a non-blocking notice; the page still works.

## 5a. Units (ADR-003)

`public/js/units.mjs`, pure:
- `parseLength(raw, unit)`: trims; accepts only a plain decimal number (`/^[0-9]*\.?[0-9]+$/` style, no sign, fraction, exponent or text); value > 0; returns `{ ok: true, value: unit === "in" ? n * 25.4 : n }` in mm, unrounded, else `{ ok: false, message }` — in inches "Enter a decimal number of inches, such as 31.5." (R1.4, R1.7).
- `formatNumber(mm, unit)`: `unit === "in" ? mm / 25.4` rounded to 3 decimals : mm rounded to 2 decimals, trailing zeros dropped (`2400`, `2400.3`, `94.488`, `31.26`); `formatLength(mm, unit)` appends ` mm` or ` in`.
- `unitSymbol(unit)` (`mm` / `in`), `unitName(unit)` (`millimetres` / `inches`), `normalizeUnit(v)`.

Examples: 94.5 in -> 2400.3 mm; 0.25 in -> 6.35 mm; 2400 mm -> 94.488 in; 794 mm -> 31.26 in; 3 mm -> 0.118 in (R1.5, R1.6, R2.5).

## 6. Web UI

- A unit selector (`<select id="unit">` or radio group: millimetres / inches) at the top; changing it saves the unit and re-renders everything from the unchanged plan (R1.5, R1.6). Every length label shows the selected unit's symbol (R1.1), every field shows `formatNumber(stored, unit)`, and lengths typed into a field are parsed with `parseLength(raw, unit)`. A field the woodworker does not edit is never written back, so its stored value survives rounding (ADR-003).
- Every length shown (bars, kerf marks, offcuts, captions, unplaced reasons, move refusals, cut sheet) is `formatLength(mm, unit)`; `data-length-mm` stays in mm (R2.5, R3.6).

- Sections: blade width field; boards list with add-board form; pieces list with add-piece form (length, quantity, optional label); layout (one bar per board); unplaced pieces panel; toolbar with "Print cut sheet" and "Clear plan". Every length input is labelled with the selected unit (R1.1).
- Lists are editable in place: changing a length or quantity or removing a row updates the plan, saves and re-renders at once (R1.3).
- Bars are flex rows where each segment's `flex-grow` (or width percentage) equals its length / board length (R2.2); pieces show length and label, kerf marks and offcut show their lengths. Stable `data-*` attributes (`data-board-id`, `data-kind`, `data-length-mm`, `data-instance-id`) make the layout checkable.
- Each piece (placed and unplaced) has a move control (a `<select>` of boards); refusal messages appear next to it and leave the layout unchanged (R3.3, R3.4).
- The unplaced panel lists each unplaced instance with its reason, and an add-board control inline (R3.1, R3.2, R3.5).
- Print: "Print cut sheet" calls `window.print()` (R5.1). A cut-sheet section (hidden on screen) states the unit at its top ("Lengths in millimetres" / "Lengths in inches") and lists, every length with its unit symbol, blade width, each board's length, its pieces in cutting order with length and label, the offcut, and an "Unplaced pieces" heading when any (R5.2, R5.4, R5.5). `@media print` hides inputs, buttons and the editing sections, shows the cut sheet and bars with black borders and patterns / greyscale rather than colour (R5.3).

## 7. Server

`server.mjs` uses only `node:http`, `node:fs`, `node:path`. It maps `/` to `public/index.html`, resolves other paths under `public/` after decoding and normalising, refuses anything that escapes `public/` (404), sets `Content-Type` for `.html`, `.css`, `.mjs`/`.js`, `.json`, `.svg`, `.ico`, and returns 200 / 404 / 405. No other routes, no writes, no network calls.

## 8. Testing

- Unit (node:test, `node --test tests/`): units parse/format examples (R1.5–R1.7, R2.5, R3.6), unit load/save and the iteration 1 plan without a unit (R4.5, R4.6); kerf arithmetic and placement examples from the spec (R2.1, R2.3, R3.1, R3.5), move checks (R3.4), store round-trip and corrupt/missing values (R4.x) with an in-memory storage stub.
- Smoke: start `node server.mjs` on a free port, GET / returns 200 with the planner page, `/styles.css` and `/js/app.mjs` return 200 with the right types.
- Acceptance: the UI criteria are exercised in a browser against the running service.

## 9. Deployment

Environment `local` (spec §7): `node server.mjs`, `PORT` default 8080; `.surety/`, `tests/`, `.git/` excluded from the artifact.
