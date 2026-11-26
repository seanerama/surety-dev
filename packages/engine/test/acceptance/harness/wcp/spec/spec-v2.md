# Workshop Cut Planner — Specification

**Spec version:** 2
**Status:** draft
**Tier:** T1
**Owner:** Project owner
**Targets:** web

## 1. Purpose

A browser-based cut planner for a woodworker who cuts pieces from boards they already own. The woodworker enters board lengths, the pieces they need and the saw's blade width (kerf), in millimetres or decimal inches chosen with a unit selector. The planner shows a visual layout of each board with the kerf lost at each cut. When the pieces do not fit, it explains why and lets the woodworker add a board or move a piece to another board. The plan and the selected unit are saved in the browser so they can be reopened, and a cut sheet stating its unit can be printed. This is iteration 2 of a rapid prototype (tier T1); it adds the millimetres/inches selector to iteration 1.

## 2. Non-goals

- Two-dimensional (sheet goods) cutting; boards are one-dimensional lengths only.
- Board width, thickness, grain direction, defects or trim allowances at board ends.
- Guaranteed optimal packing; a simple heuristic placement is sufficient.
- Fractional inches (such as 3/4 or 31 1/2), feet-and-inches entry, units other than millimetres and inches, and mixing units within one plan.
- User accounts, server-side storage, sharing or syncing plans between devices or browsers.
- Several named plans; one plan per browser is kept.
- Cost, offcut inventory or purchase suggestions.

## 3. Users and situations

- A hobby or professional woodworker at a computer or tablet in the workshop, before cutting, who knows the lengths of the boards on hand and the pieces a project needs, measured in millimetres or in inches.
- The woodworker returns later in the same browser to reopen the plan in the unit they last chose, and prints a cut sheet to take to the saw.
- A woodworker who saved a plan with iteration 1 (millimetres only) reopens it after the update.

## 4. Requirements

### R1. Enter boards, pieces and blade width in millimetres or inches

The woodworker can choose millimetres or inches with a unit selector and enter the saw's blade width, a list of board lengths and a list of needed pieces (each with a length, a quantity and an optional label) in the selected unit, and can edit or remove any entry; invalid values are refused with a visible message. Switching the unit changes how lengths are shown and entered, never the physical measurements: lengths are kept in millimetres and shown in inches to at most 3 decimals and in millimetres to at most 2 decimals, trailing zeros dropped.

**Surface:** ui
**Sensitive areas:** none

- R1.1 The page shows a blade width field, a board list with an add-board control, and a piece list with an add-piece control taking a length, a quantity and an optional label, each length labelled with the selected unit (mm when no unit has been chosen).
- R1.2 After adding boards of 2400 mm and 1200 mm and a piece of 800 mm with quantity 3, the board list shows both boards and the piece list shows the piece with quantity 3.
- R1.3 Editing a board's length or a piece's length or quantity, or removing a board or a piece, updates the lists and the layout at once.
- R1.4 Entering a zero, negative or non-numeric length, quantity or blade width shows a message next to that field and the value is not used in the layout.
- R1.5 The page shows a unit selector offering millimetres and inches; with inches selected, adding a 94.5 in board and a 31.5 in piece and setting a 0.25 in blade shows them as 94.5 in, 31.5 in and 0.25 in, and switching to millimetres then shows 2400.3 mm, 800.1 mm and 6.35 mm.
- R1.6 With a 2400 mm board, an 800 mm piece and a 3 mm blade entered in millimetres, switching to inches shows 94.488 in, 31.496 in and 0.118 in, and switching back and forth several times shows 2400 mm, 800 mm and 3 mm again each time in millimetres, with the same layout and offcuts throughout.
- R1.7 With inches selected, entering a fraction such as 3/4 or a value with text such as 31in in a length or the blade width shows a message asking for a decimal number of inches, and the value is not used in the layout.

### R2. Visual cut layout with kerf

The planner places every needed piece on a board and draws each board to scale as a bar, showing each placed piece, the kerf lost at each cut and the remaining offcut, with their lengths in the selected unit; a cut uses one blade width of material between adjacent pieces and before any remaining offcut.

**Surface:** ui
**Sensitive areas:** none

- R2.1 With one 2400 mm board, a 3 mm blade and two 800 mm pieces, the layout shows one bar with two 800 mm pieces, two 3 mm kerf marks and a 794 mm offcut.
- R2.2 Each bar's segments are drawn in proportion to their lengths, and each piece shows its length and its label when it has one.
- R2.3 With one 2400 mm board, a 3 mm blade and three 800 mm pieces, adding a second board of 2400 mm puts all three pieces on the boards with no piece left unplaced, and the piece, kerf and offcut lengths on each bar add up to that board's length.
- R2.4 Changing the blade width redraws the layout with the new kerf length on every cut.
- R2.5 In the situation of R2.1, switching to inches shows the same bar with two 31.496 in pieces, two 0.118 in kerf marks and a 31.26 in offcut, drawn in the same proportions, and switching back shows the R2.1 lengths in mm.

### R3. Explain pieces that do not fit, and fix by adding a board or moving a piece

When a piece cannot be placed, the planner lists it as unplaced and explains why in the selected unit; the woodworker can add a board, or move a placed or unplaced piece to a chosen board, and the planner refuses a move that would not fit, saying why.

**Surface:** ui
**Sensitive areas:** none

- R3.1 With one 2400 mm board, a 3 mm blade and three 800 mm pieces, the planner shows one 800 mm piece as unplaced and a message stating that the three pieces need 2406 mm (2400 mm of pieces plus 6 mm for two cuts) but the board is 2400 mm.
- R3.2 In the situation of R3.1, the message offers an add-board control; adding a 1200 mm board through it places the unplaced piece and the message disappears.
- R3.3 The woodworker can move any piece to another board with a move control on the piece; the layout of both boards redraws with the piece in its new place.
- R3.4 Moving a piece to a board without room for it leaves the layout unchanged and shows a message giving the piece length, the kerf and the space left on that board in the selected unit.
- R3.5 A piece longer than every board is shown as unplaced with a message naming the piece length and the longest board length.
- R3.6 In the situation of R3.1, switching to inches keeps the same piece unplaced and the message states the lengths in inches: 94.724 in needed (94.488 in of pieces plus 0.236 in for two cuts) but the board is 94.488 in.

### R4. Save the plan in this browser and reopen it

The plan (blade width, boards, pieces and any manual piece placements) and the selected unit are saved in the browser's local storage as they change, and reopening the page in the same browser restores them; a plan saved by the previous version, which has no unit, reopens unchanged in millimetres.

**Surface:** ui
**Sensitive areas:** none

- R4.1 After entering a blade width, boards and pieces and reloading the page, the same values and the same layout are shown.
- R4.2 A piece moved to another board with the move control is still on that board after reloading the page.
- R4.3 A clear-plan control, after a confirmation, empties the plan, and reloading the page shows the empty plan.
- R4.4 Opening the page for the first time in a browser with no saved plan shows an empty plan with no error, with millimetres selected.
- R4.5 After selecting inches and reloading the page, inches is still selected and the lengths are shown in inches with the same values and layout as before the reload; the same holds for millimetres.
- R4.6 Opening the page in a browser holding a plan saved by the previous version (a 3 mm blade, a 2400 mm board and three 800 mm pieces, with no unit saved) shows millimetres selected, the blade, board and pieces as 3 mm, 2400 mm and 800 mm, and the layout of R3.1, with nothing re-entered.

### R5. Print a cut sheet

The woodworker can print a cut sheet of the plan: for each board, its length and the ordered cuts with piece lengths, labels and the offcut, plus the blade width and any unplaced pieces, all in the selected unit which the sheet states clearly, laid out for paper without the editing controls.

**Surface:** ui
**Sensitive areas:** none

- R5.1 A print cut sheet control opens the browser's print dialog.
- R5.2 The print view lists the blade width and, for each board, its length, each piece in cutting order with its length and label, and the offcut length.
- R5.3 The print view hides the input fields and buttons and shows the board bars in black and white legibly.
- R5.4 When pieces are unplaced, the print view lists them under a heading for unplaced pieces.
- R5.5 The print view states the selected unit at its top (millimetres or inches) and every length on it carries that unit's symbol; with inches selected, the R2.1 plan prints 31.496 in pieces, a 0.118 in blade and a 31.26 in offcut.

## 5. Requirement index

| Key | Title | Phase | Sensitive areas | Criteria | Origin |
| --- | --- | --- | --- | --- | --- |
| R1 | Enter boards, pieces and blade width in millimetres or inches | 1 | none | R1.1, R1.2, R1.3, R1.4, R1.5, R1.6, R1.7 | intended |
| R2 | Visual cut layout with kerf | 1 | none | R2.1, R2.2, R2.3, R2.4, R2.5 | intended |
| R3 | Explain pieces that do not fit, and fix by adding a board or moving a piece | 1 | none | R3.1, R3.2, R3.3, R3.4, R3.5, R3.6 | intended |
| R4 | Save the plan in this browser and reopen it | 1 | none | R4.1, R4.2, R4.3, R4.4, R4.5, R4.6 | intended |
| R5 | Print a cut sheet | 1 | none | R5.1, R5.2, R5.3, R5.4, R5.5 | intended |

## 6. Modules and protected paths

| Module | Paths | Sensitive areas |
| --- | --- | --- |
| Static server | server.mjs | none |
| Web client | public/ | none |
| Tests | tests/ | none |

## 7. Environments

### local

- **Purpose:** Run the prototype as a local service on this host for acceptance and smoke checks.
- **Verified means:** Start the service, open the page in a browser and exercise the acceptance criteria; HTTP GET / returns the page.
- **Target:** local service on this host
- **Runtime and start command:** Node.js (LTS), no dependencies; `node server.mjs`
- **Port:** the PORT environment variable, default 8080
- **Excluded from the artifact:** .surety/, tests/, .git/
- **Required post-deploy behaviour check:** GET / returns status 200 with the planner page, and the page loads its script and stylesheet without errors.
- **Stable arguments:** none

## 8. Constraints

- Lengths and the blade width are entered and shown in millimetres or decimal inches, as selected; 1 in = 25.4 mm exactly.
- Lengths are kept and calculated in millimetres at the precision entered; switching the unit only converts what is shown, so it never changes a measurement, the layout or the offcuts. Shown values are rounded to at most 3 decimals in inches and 2 decimals in millimetres.
- A plan saved by the previous version (no unit saved) must reopen unchanged, in millimetres.
- The plan and the selected unit are stored only in this browser (local storage); no server-side storage and no network calls beyond serving the static files.
- The service is a dependency-free Node.js static file server; the client is plain HTML, CSS and JavaScript with no build step and no external CDN.
- Kerf rule: one blade width is lost at each cut between adjacent pieces and before any remaining offcut; no cut is needed after the last piece when it ends exactly at the board's end. Example: three 800 mm pieces need 2406 mm and so cannot come from one 2400 mm board with a 3 mm blade.

## 9. Interfaces and data

- HTTP: GET / serves public/index.html; other GET requests serve files under public/; nothing else.
- Saved plan, one JSON value in local storage under the key `cutPlanner.plan`, unchanged from the previous version and always in millimetres: `{ "version": 1, "bladeMm": number, "boards": [{ "id": string, "lengthMm": number }], "pieces": [{ "id": string, "lengthMm": number, "quantity": integer, "label": string }], "placements": { "<piece instance id>": "<board id>" } }`. Lengths may now be non-integer millimetres (from inch entries).
- Selected unit, one string in local storage under the key `cutPlanner.unit`: `"mm"` or `"in"`; a missing or unrecognised value means `"mm"`. Clearing the plan keeps the selected unit.
- Conversion: a value entered in inches is stored as inches × 25.4 mm; a field left unedited keeps its stored value, whatever its rounded display.
- Placement: pieces are placed longest first on the first board with room (first-fit decreasing), after honouring manual placements; a piece that fits no board is unplaced.

## 10. Open questions

None.

## 11. Change log

| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-11-25 | First approved version | human |
| 2 | 2026-11-24 | Iteration 2 change request: millimetres/inches selector for board, piece and blade lengths (decimal inches); switching preserves measurements, layout and offcuts; previous-version plans reopen in mm; selected unit remembered and shown on the cut sheet. Added R1.5–R1.7, R2.5, R3.6, R4.5, R4.6, R5.5; R1, R3, R4 and R5 statements and R1.1, R3.4, R4.4 reworded for the selected unit. | pending |
