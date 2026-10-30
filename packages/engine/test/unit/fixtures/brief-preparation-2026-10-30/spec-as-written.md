# Lap-Lab — Prototype Specification (iteration 1)

Source: `.surety/idea.md` version 1. This is the minimal specification for a rapid prototype; it deliberately covers a reduced scope of the idea (see §9).

## 1 Purpose

Lap-Lab is a fun desktop browser game in which the player acts as a race engineer: on one section of a fictional circuit they change exactly one variable, watch an animated run against a fixed reference, and use telemetry to explain what happened. The prototype must show that core experiment loop working end to end, with coherent cause and effect and a professional dark motorsport-console look.

## 2 Users

- Adults with general technical curiosity and no prior racing expertise, playing for fun on a desktop browser.
- Human reviewers judging the experience against the idea's review dimensions (teaching clarity, experimental discipline, evidence quality, visual synchronization, professional presentation, usability, completeness).

## 3 Scope of this prototype

Included:
- A single-page desktop web game with a fictional, believable circuit (long straight, heavy braking zone, tight corner, faster sweeping corner, exit onto a straight), drawn as a full map plus a larger detailed view of the active section.
- Three lessons from the idea's Section 5, each with a named section (start, finish, direction, distance), one adjustable variable, a stated goal and listed fixed conditions:
  - L1 Acceleration on a straight — variable: vehicle mass.
  - L2 Finding the braking point — variable: braking start position.
  - L3 Using available corner grip — variable: target corner speed.
- The experiment loop: understand the question → inspect reference → multiple-choice prediction (before the first changed run only) → change the variable → run → compare → multiple-choice interpretation → refine or advance.
- An animated car plus a distinct reference ghost, progressively drawn distance-based telemetry graphs (speed, throttle/brake, longitudinal and lateral acceleration, time delta) with a synchronized cursor and numeric readouts.
- Play, pause, replay and a position scrubber; graph point selection; keyboard inspection.
- A compact tire grip-demand indicator for L2 and L3.
- Result panel (section time, delta, status) and an in-session experiment history that can be revisited.
- A deterministic, illustrative point-mass vehicle model computed in the browser.

## 4 Requirements

### R1 — Lesson setup, circuit map and single-variable control

Objective: on load, the player immediately sees the selected lesson, its question, the active section on the full circuit map, the single adjustable variable and how to start.

Acceptance criteria (checked by using the running prototype):
1. Opening the app shows, without scrolling at a 1280×800 window, the lesson title and question, the full circuit map, the active section highlighted by colour and a labelled outline with start/finish marks and travel direction, the remaining circuit dimmed but visible, and a clearly labelled "Run" action.
2. A lesson selector offers L1, L2 and L3; selecting one changes the highlighted section, the section name/distance, the goal, the fixed-conditions list and the one variable control.
3. Each lesson shows exactly one adjustable control, with its value, units, reference value and a one-line explanation; all other conditions are shown as a read-only "held constant" list.
4. A larger detailed view shows the same active section geometry as the map, with lesson-relevant markers only (e.g. brake marker, apex) and the car at the same position as on the map.
5. The UI uses a dark charcoal theme, off-white text and a lime/yellow-green accent; reference and experiment are distinguished by colour and by a second cue (line pattern or label).

### R2 — Animated run with synchronized, growing telemetry

Objective: running an experiment animates the car through the section while telemetry traces draw progressively, and every view stays in sync during playback and inspection.

Acceptance criteria:
1. Pressing Run animates a recognizable car whose orientation follows the track, which visibly slows in braking zones and speeds up on straights; a distinct ghost car shows the reference at the same elapsed replay time.
2. Telemetry graphs use distance along the section as the x-axis, have labelled axes with units and a legend, and keep a fixed scale within a lesson; the experiment trace grows as the car advances while the reference trace stays visible and is labelled as reference.
3. A cursor on the graphs, the car on map and detailed view, and the numeric readouts (distance, reference value, experiment value, difference) describe the same moment at all times during play.
4. Pause freezes everything; Replay repeats the progressive reveal; a position scrubber moves car, cursor and readouts together after the run completes.
5. Clicking a graph point moves the car and readouts to that distance; with keyboard focus on the graph, arrow keys step the inspection position and update the readouts.
6. If playback is accelerated, the pace is labelled, and the displayed section time is the simulated result, not the animation duration.

### R3 — Coherent, deterministic physics including unsuccessful runs

Objective: changing the lesson's variable produces a believable, consistent change in behaviour, telemetry and outcome, and infeasible choices are shown as unsuccessful rather than fast.

Acceptance criteria:
1. Running the same value twice gives identical section time and traces.
2. L1: increasing mass lowers longitudinal acceleration and increases section time with unchanged propulsion; decreasing mass does the opposite.
3. L2: braking later reduces time until the corner entry speed can no longer be reached; such a run is marked "Unsuccessful — entry too fast" (or similar) with no valid best time, and the grip indicator shows demand above the limit at the failing point.
4. L3: higher target corner speed reduces time up to the grip limit; above it the run stops at or flags the point where demand exceeds grip and is marked unsuccessful, never shown as completing the line while over the limit.
5. The grip-demand indicator (requested vs available, labelled braking/turning/accelerating) agrees with the run's success or failure at every inspected position.

### R4 — Results, comparison and session history

Objective: the player can see what each run achieved compared with the reference, and revisit earlier runs within the session.

Acceptance criteria:
1. After a run, a result panel shows section time, time gained or lost vs reference (with sign and a non-colour cue), the lesson's key metric (e.g. exit speed, entry speed, minimum corner speed) and a valid/unsuccessful status.
2. Changing the control marks the next run as "pending" and the displayed graphs/results stay labelled as belonging to the last completed run until the new run finishes.
3. A history list shows recent runs in the session (variable value, section time or unsuccessful status, delta to reference); selecting an entry restores its traces and result for inspection.
4. A "best valid" result, if shown, never comes from an unsuccessful run.
5. A reset action returns the control to the reference value; reloading the page clears all history and progress.

### R5 — Prediction, interpretation and evidence-based feedback

Objective: each lesson asks the player to predict and then explain with multiple-choice questions, and gives feedback that cites the observed evidence, ending in a visible completion state.

Acceptance criteria:
1. Before the first changed run of a lesson, a short multiple-choice prediction is asked; later runs do not ask again.
2. After a run meeting the lesson's goal (or after an informative run), a multiple-choice interpretation question about the evidence is offered; answering gives feedback naming the player's adjustment, the observed result, where on the section it mattered (distance), and the physical reason.
3. Feedback for an unsuccessful or slower run explains the cause shown in the telemetry rather than generic praise or blame.
4. Meeting the goal and answering the interpretation question marks the lesson complete with a restrained completion badge; experimentation remains available and the next lesson is offered.

## 5 Behaviour and data model

- Vehicle: an illustrative, internally consistent point-mass model with fixed propulsion power/force limit, aerodynamic drag, braking deceleration limit, and a friction-circle grip limit (combined longitudinal + lateral demand ≤ available grip). Values are illustrative and labelled as an educational scenario.
- Track: a fixed racing line defined as a polyline/spline with curvature; each lesson section is a distance range on it with a fixed entry speed.
- Simulation: forward integration along distance at fixed step, producing per-sample distance, time, speed, throttle, brake, longitudinal and lateral acceleration, grip demand ratio and position/heading. Deterministic; no randomness.
- Driver: fixed behaviour except the lesson variable; it never secretly compensates for the player's choice.
- Session state lives only in memory.

## 6 Interfaces

- Single-page UI only; no external API, no backend endpoints beyond serving static files.
- Inputs: mouse and keyboard (lesson select, slider/stepper, Run, Play/Pause, Replay, scrubber, graph inspection with arrow keys, multiple-choice answers).

## 7 Environments

| Name | Description |
| --- | --- |
| local | The prototype runs as a local service on this host: a static web server serves the single-page app (HTML/CSS/JS) and all simulation and rendering run in the desktop browser. No database, no external network calls at runtime. |

## 8 Constraints

- Desktop browsers only; layout targeted at 1280×800 and larger, remaining usable in smaller desktop windows.
- No persistence: nothing saved between visits; no accounts, analytics or answer collection.
- Answers are multiple choice only.
- The circuit is fictional and must not copy or name a real track.
- No sound, no localization, no manual driving, no real telemetry, no import/export, no multiplayer/leaderboards.
- Exactly one adjustable variable per experimental run.
- Professional dark motorsport-console visual standard; no colour-only distinctions.
- Must be buildable within the prototype budget (about 1.5M tokens, about USD 15, 45 minutes of runtime).

## 9 Mocked, left out and assumptions

Mocked:
- Vehicle physics are a simplified illustrative point-mass model, not a validated vehicle dynamics simulation.
- Telemetry is generated from the model, not recorded.

Left out of this prototype (idea features not built in iteration 1):
- L4 Building corner exit speed (throttle application point).
- L5 Balancing drag and downforce (wing setting) and aerodynamic force arrows.
- L6 Reading a questionable signal (sensor noise, raw vs smoothed view, withheld explanation).
- The integrated final exercise over the whole circuit, including whole-lap vs section results.
- Selecting a location directly on the track section to inspect it (graph and scrubber inspection only).
- A broader set of discoverable extra signals beyond the lesson's core set.

Assumptions:
- "Runs on the player's machine with no server" is satisfied by a plain static file server on localhost; there is no application backend.
- Plain HTML/CSS/JavaScript with SVG/Canvas rendering (no heavy framework) is acceptable.
- Illustrative numbers (distances, masses, speeds) may be chosen freely as long as they are coherent.
- Reviewers use a current Chromium- or Firefox-based desktop browser.

## 10 Known limitations

- Only three of the six lessons; no final exercise.
- Physics are simplified (no weight transfer, tire temperature, gearing detail or yaw dynamics).
- The "loss of control" for infeasible runs is shown as stopping/flagging at the limit, not as a physical spin animation.
- Accessibility covers keyboard graph inspection, focus states and non-colour cues, but has no formal audit; reduced motion relies on pause and scrubber.
- No automated test of visual quality; polish is judged by reviewers.

## 11 Open questions

None.
