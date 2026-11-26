# Workshop Cut Planner — Architecture

**Architecture version:** 1
**Spec version:** 1
**Tier:** T1
**Targets:** web

## 1. Overview

A single-page browser application served by a dependency-free Node.js static file server. All planning logic, state and persistence live in the browser; the server only serves the files under `public/`. There is no build step, no package dependency and no external CDN (ADR-001).

```
browser ──GET──▶ server.mjs ──▶ public/index.html, public/styles.css, public/js/*.mjs
   │
   └─ public/js/app.mjs (web-ui) ──uses──▶ planner.mjs (planner-core)
                                 └─uses──▶ store.mjs   (plan-store) ──▶ localStorage["cutPlanner.plan"]
```

## 2. Modules

| Module | Paths | Responsibility | Spec module |
| --- | --- | --- | --- |
| static-server | `server.mjs` | Serve `GET /` as `public/index.html` and other GET paths from `public/`; 404 otherwise; 405 for non-GET/HEAD; refuse path traversal. Port from `PORT`, default 8080. | Static server |
| planner-core | `public/js/planner.mjs` | Pure functions, no DOM: validation of numbers, expansion of pieces into instances, kerf arithmetic, placement (manual placements first, then first-fit decreasing), unplaced explanations, move checks. | Web client |
| plan-store | `public/js/store.mjs` | Load, save and clear the plan in `localStorage` under `cutPlanner.plan`, tolerating a missing or corrupt value. | Web client |
| web-ui | `public/index.html`, `public/styles.css`, `public/js/app.mjs` | Input forms and lists, field messages, board bars to scale, unplaced list with add-board, move controls, clear-plan, print cut sheet and the print stylesheet. | Web client |
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

Unplaced reasons (`reason` carries both a machine code and a sentence in mm):
- `TOO_LONG` — the piece is longer than every board: "Piece 3000 mm is longer than the longest board (2400 mm)." (R3.5); also used when there are no boards.
- `NO_ROOM` — for the board with the most free space: "These 3 pieces need 2406 mm (2400 mm of pieces plus 6 mm for 2 cuts) but the board is 2400 mm." — counting that board's pieces plus this one, with (n−1) cuts (R3.1).

`checkMove(plan, layout, instanceId, boardId) -> { ok: true } | { ok: false, message }`: tests fit against the target board's current pieces excluding the moved instance; the refusal states the piece length, the kerf and the space left on that board in mm (R3.4). `applyMove` returns a new plan with `placements[instanceId] = boardId`.

All functions are pure and return new objects; the UI re-renders from `computeLayout` on every change.

## 5. Plan store

- `loadPlan(storage = localStorage) -> Plan`: missing key, JSON parse error, wrong `version` or malformed shape returns the empty plan (`bladeMm` 3, no boards, no pieces, no placements) without throwing (R4.4); invalid entries are dropped.
- `savePlan(plan, storage)`: writes the JSON; called by the UI after every plan change (R4.1, R4.2).
- `clearPlan(storage)`: removes the key; the UI asks `confirm()` first, then resets to the empty plan and saves it (R4.3).
- A storage exception (quota, disabled storage) is caught and shown as a non-blocking notice; the page still works.

## 6. Web UI

- Sections: blade width field; boards list with add-board form; pieces list with add-piece form (length, quantity, optional label); layout (one bar per board); unplaced pieces panel; toolbar with "Print cut sheet" and "Clear plan". Every length input is labelled "mm" (R1.1).
- Lists are editable in place: changing a length or quantity or removing a row updates the plan, saves and re-renders at once (R1.3).
- Bars are flex rows where each segment's `flex-grow` (or width percentage) equals its length / board length (R2.2); pieces show length and label, kerf marks and offcut show their lengths. Stable `data-*` attributes (`data-board-id`, `data-kind`, `data-length-mm`, `data-instance-id`) make the layout checkable.
- Each piece (placed and unplaced) has a move control (a `<select>` of boards); refusal messages appear next to it and leave the layout unchanged (R3.3, R3.4).
- The unplaced panel lists each unplaced instance with its reason, and an add-board control inline (R3.1, R3.2, R3.5).
- Print: "Print cut sheet" calls `window.print()` (R5.1). A cut-sheet section (hidden on screen) lists blade width, each board's length, its pieces in cutting order with length and label, the offcut, and an "Unplaced pieces" heading when any (R5.2, R5.4). `@media print` hides inputs, buttons and the editing sections, shows the cut sheet and bars with black borders and patterns / greyscale rather than colour (R5.3).

## 7. Server

`server.mjs` uses only `node:http`, `node:fs`, `node:path`. It maps `/` to `public/index.html`, resolves other paths under `public/` after decoding and normalising, refuses anything that escapes `public/` (404), sets `Content-Type` for `.html`, `.css`, `.mjs`/`.js`, `.json`, `.svg`, `.ico`, and returns 200 / 404 / 405. No other routes, no writes, no network calls.

## 8. Testing

- Unit (node:test, `node --test tests/`): kerf arithmetic and placement examples from the spec (R2.1, R2.3, R3.1, R3.5), move checks (R3.4), store round-trip and corrupt/missing values (R4.x) with an in-memory storage stub.
- Smoke: start `node server.mjs` on a free port, GET / returns 200 with the planner page, `/styles.css` and `/js/app.mjs` return 200 with the right types.
- Acceptance: the UI criteria are exercised in a browser against the running service.

## 9. Deployment

Environment `local` (spec §7): `node server.mjs`, `PORT` default 8080; `.surety/`, `tests/`, `.git/` excluded from the artifact.
