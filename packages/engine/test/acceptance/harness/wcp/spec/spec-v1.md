# Workshop Cut Planner — Specification

**Spec version:** 1
**Status:** draft
**Tier:** T1
**Owner:** Project owner
**Targets:** web

## 1. Purpose

A browser-based cut planner for a woodworker who cuts pieces from boards they already own. The woodworker enters board lengths, the pieces they need and the saw's blade width (kerf), all in millimetres. The planner shows a visual layout of each board with the kerf lost at each cut. When the pieces do not fit, it explains why and lets the woodworker add a board or move a piece to another board. The plan is saved in the browser so it can be reopened, and a cut sheet can be printed. This is iteration 1 of a rapid prototype (tier T1).

## 2. Non-goals

- Two-dimensional (sheet goods) cutting; boards are one-dimensional lengths only.
- Board width, thickness, grain direction, defects or trim allowances at board ends.
- Guaranteed optimal packing; a simple heuristic placement is sufficient.
- Units other than millimetres, and imperial conversion.
- User accounts, server-side storage, sharing or syncing plans between devices or browsers.
- Several named plans; one plan per browser is kept.
- Cost, offcut inventory or purchase suggestions.

## 3. Users and situations

- A hobby or professional woodworker at a computer or tablet in the workshop, before cutting, who knows the lengths of the boards on hand and the pieces a project needs.
- The woodworker returns later in the same browser to reopen the plan and prints a cut sheet to take to the saw.

## 4. Requirements

### R1. Enter boards, pieces and blade width in millimetres

The woodworker can enter the saw's blade width, a list of board lengths and a list of needed pieces (each with a length, a quantity and an optional label), all in millimetres, and can edit or remove any entry; invalid values are refused with a visible message.

**Surface:** ui
**Sensitive areas:** none

- R1.1 The page shows a blade width field, a board list with an add-board control, and a piece list with an add-piece control taking a length, a quantity and an optional label, each length labelled in mm.
- R1.2 After adding boards of 2400 mm and 1200 mm and a piece of 800 mm with quantity 3, the board list shows both boards and the piece list shows the piece with quantity 3.
- R1.3 Editing a board's length or a piece's length or quantity, or removing a board or a piece, updates the lists and the layout at once.
- R1.4 Entering a zero, negative or non-numeric length, quantity or blade width shows a message next to that field and the value is not used in the layout.

### R2. Visual cut layout with kerf

The planner places every needed piece on a board and draws each board to scale as a bar, showing each placed piece, the kerf lost at each cut and the remaining offcut, with their lengths in millimetres; a cut uses one blade width of material between adjacent pieces and before any remaining offcut.

**Surface:** ui
**Sensitive areas:** none

- R2.1 With one 2400 mm board, a 3 mm blade and two 800 mm pieces, the layout shows one bar with two 800 mm pieces, two 3 mm kerf marks and a 794 mm offcut.
- R2.2 Each bar's segments are drawn in proportion to their lengths, and each piece shows its length and its label when it has one.
- R2.3 With one 2400 mm board, a 3 mm blade and three 800 mm pieces, adding a second board of 2400 mm puts all three pieces on the boards with no piece left unplaced, and the piece, kerf and offcut lengths on each bar add up to that board's length.
- R2.4 Changing the blade width redraws the layout with the new kerf length on every cut.

### R3. Explain pieces that do not fit, and fix by adding a board or moving a piece

When a piece cannot be placed, the planner lists it as unplaced and explains why in millimetres; the woodworker can add a board, or move a placed or unplaced piece to a chosen board, and the planner refuses a move that would not fit, saying why.

**Surface:** ui
**Sensitive areas:** none

- R3.1 With one 2400 mm board, a 3 mm blade and three 800 mm pieces, the planner shows one 800 mm piece as unplaced and a message stating that the three pieces need 2406 mm (2400 mm of pieces plus 6 mm for two cuts) but the board is 2400 mm.
- R3.2 In the situation of R3.1, the message offers an add-board control; adding a 1200 mm board through it places the unplaced piece and the message disappears.
- R3.3 The woodworker can move any piece to another board with a move control on the piece; the layout of both boards redraws with the piece in its new place.
- R3.4 Moving a piece to a board without room for it leaves the layout unchanged and shows a message giving the piece length, the kerf and the space left on that board in mm.
- R3.5 A piece longer than every board is shown as unplaced with a message naming the piece length and the longest board length.

### R4. Save the plan in this browser and reopen it

The plan (blade width, boards, pieces and any manual piece placements) is saved in the browser's local storage as it changes, and reopening the page in the same browser restores it.

**Surface:** ui
**Sensitive areas:** none

- R4.1 After entering a blade width, boards and pieces and reloading the page, the same values and the same layout are shown.
- R4.2 A piece moved to another board with the move control is still on that board after reloading the page.
- R4.3 A clear-plan control, after a confirmation, empties the plan, and reloading the page shows the empty plan.
- R4.4 Opening the page for the first time in a browser with no saved plan shows an empty plan with no error.

### R5. Print a cut sheet

The woodworker can print a cut sheet of the plan: for each board, its length and the ordered cuts with piece lengths, labels and the offcut, plus the blade width and any unplaced pieces, laid out for paper without the editing controls.

**Surface:** ui
**Sensitive areas:** none

- R5.1 A print cut sheet control opens the browser's print dialog.
- R5.2 The print view lists the blade width and, for each board, its length, each piece in cutting order with its length and label, and the offcut length.
- R5.3 The print view hides the input fields and buttons and shows the board bars in black and white legibly.
- R5.4 When pieces are unplaced, the print view lists them under a heading for unplaced pieces.

## 5. Requirement index

| Key | Title | Phase | Sensitive areas | Criteria | Origin |
| --- | --- | --- | --- | --- | --- |
| R1 | Enter boards, pieces and blade width in millimetres | 1 | none | R1.1, R1.2, R1.3, R1.4 | intended |
| R2 | Visual cut layout with kerf | 1 | none | R2.1, R2.2, R2.3, R2.4 | intended |
| R3 | Explain pieces that do not fit, and fix by adding a board or moving a piece | 1 | none | R3.1, R3.2, R3.3, R3.4, R3.5 | intended |
| R4 | Save the plan in this browser and reopen it | 1 | none | R4.1, R4.2, R4.3, R4.4 | intended |
| R5 | Print a cut sheet | 1 | none | R5.1, R5.2, R5.3, R5.4 | intended |

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

- All lengths and the blade width are in millimetres.
- The plan is stored only in this browser (local storage); no server-side storage and no network calls beyond serving the static files.
- The service is a dependency-free Node.js static file server; the client is plain HTML, CSS and JavaScript with no build step and no external CDN.
- Kerf rule: one blade width is lost at each cut between adjacent pieces and before any remaining offcut; no cut is needed after the last piece when it ends exactly at the board's end. Example: three 800 mm pieces need 2406 mm and so cannot come from one 2400 mm board with a 3 mm blade.

## 9. Interfaces and data

- HTTP: GET / serves public/index.html; other GET requests serve files under public/; nothing else.
- Saved plan, one JSON value in local storage under the key `cutPlanner.plan`: `{ "version": 1, "bladeMm": number, "boards": [{ "id": string, "lengthMm": number }], "pieces": [{ "id": string, "lengthMm": number, "quantity": integer, "label": string }], "placements": { "<piece instance id>": "<board id>" } }`.
- Placement: pieces are placed longest first on the first board with room (first-fit decreasing), after honouring manual placements; a piece that fits no board is unplaced.

## 10. Open questions

None.

## 11. Change log

- Version 1 (2026-11-24): first draft for iteration 1 of the rapid prototype, from the idea version 1.
