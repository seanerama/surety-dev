# Idea: Waterlog

**Date:** 2026-10-17
**Owner:** Sean
**Status:** APPROVED by Sean with three edits (E162 item 3, 2026-10-17), applied here by the Verifier: Android notifications moved to future work; the held-logo sequence made mandatory; Android stated as source plus a labelled simulation. Written by the slice-46 Verifier (BS6 §12: "a purpose-written small web-and-`android` brief", E156 Q5). The run reads this file (or `SURETY_M535_BRIEF`) as the project's idea. Approving the brief replaces neither the later specification and design approvals nor M535's prerequisites (E162 item 3; E156 Q5): nothing here is a requirement until Sean's Spec Writer session writes it and he approves it.

## The idea in one paragraph

Waterlog keeps track of when the house plants were last watered. A small JSON API holds the plants and their last watering; a web page and an Android app list the plants, show which are due, and log a watering, sharing one look, one logo and one workflow. The specification should say `**Targets:** web, android` and `**Cross-platform:** yes`.

## Who it is for

The household: on a laptop at the desk, and on a phone standing by the plants.

## First version

- GET /api/plants lists the plants with each one's last watering and whether it is due; POST /api/plants adds a plant with its interval in days; POST /api/plants/:name/watered logs a watering now
- a web page (HTML and CSS, served by the API) that lists the plants, marks the due ones and logs a watering
- an Android app (React Native) that does the same: **source plus a labelled simulation**. Nothing runs it in M6: its screens are seen only as the preview's simulation inside the engine's labelled frame, and its cross-target behaviour (a watering logged on one target showing on the other, a plant marked due on both) **stays unverified on Android until a native runtime is exercised**; its human test stays pending
- a logo the Designer proposes, in a **mandatory held-logo sequence**: the owner holds the first proposal at the first design approval; the UI stages build with the placeholder; then the owner approves the logo (the Designer's proposal, or his own file) through an asset-only approval, and the run verifies that it propagates (the effective version moved, the `asset_updated` work integrated, the parity checks passing on the new `slot@version`)

## Deliberately out

- accounts and sharing between households
- persistence across restarts
- photos of the plants, care advice, any data from outside
- notifications of any kind, on Android or elsewhere (see future work)

## Future work (not this version)

- Android notifications reminding the household when a plant is due (removed from this version by E162 item 3): the app asks for no permission and has no notification screen or state
- cross-target behaviour verified on a native Android runtime

## Constraints

- Node's own modules only for the API; no package.json
- the web page reads the design's tokens; the Android app reads the neutral tokens
- one phase: the API, the web page and the Android app
- the API stays simple: the three routes above, JSON bodies, no persistence (kept by E162 item 3)
- the Android app asks for no platform permission

## Where it runs

On the owner's machine as a user service (alpha): `node server.mjs` on `PORT`, the API serving the web page at `/`.

## Risk tier, if you have a view

T2

```yaml surety-identity
name: Waterlog
one_line: When the house plants were last watered, in the browser and on Android, with a JSON API.
users:
  - the household, on a laptop
  - the household, on an Android phone
non_goals:
  - accounts and sharing
  - persistence across restarts
  - photos and care advice
  - notifications
success_measures:
  - a watering logged on the web shows on the web after a reload, and the Android source does the same against the API (verified on Android only once a native runtime is exercised)
  - a plant past its interval is marked due on the web, and in the Android source (Android unverified until a native runtime is exercised)
  - the held logo, once approved, replaces the placeholder in both targets' builds
sensitive_areas: none
tier_recommendation: T2
environments:
  - alpha
```
