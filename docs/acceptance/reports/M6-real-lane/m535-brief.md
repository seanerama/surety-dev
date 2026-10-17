# Idea: Waterlog

**Date:** 2026-10-17
**Owner:** Sean
**Status:** DRAFT for Sean, by the slice-46 Verifier (BS6 §12: "a purpose-written small web-and-`android` brief", E156 Q5). Sean edits or replaces it before M535 runs; the run reads this file (or `SURETY_M535_BRIEF`) as the project's idea. Nothing here is a requirement until his Spec Writer session writes it and he approves it.

## The idea in one paragraph

Waterlog keeps track of when the house plants were last watered. A small JSON API holds the plants and their last watering; a web page and an Android app list the plants, show which are due, and log a watering, sharing one look, one logo and one workflow. The specification should say `**Targets:** web, android` and `**Cross-platform:** yes`.

## Who it is for

The household: on a laptop at the desk, and on a phone standing by the plants.

## First version

- GET /api/plants lists the plants with each one's last watering and whether it is due; POST /api/plants adds a plant with its interval in days; POST /api/plants/:name/watered logs a watering now
- a web page (HTML and CSS, served by the API) that lists the plants, marks the due ones and logs a watering
- an Android app (React Native, source only: nothing runs it in M6) that does the same, and asks for notifications to remind the household when a plant is due
- a logo the Designer proposes; the owner may hold it at the first approval and approve it, or his own file, later

## Deliberately out

- accounts and sharing between households
- persistence across restarts
- photos of the plants, care advice, any data from outside

## Constraints

- Node's own modules only for the API; no package.json
- the web page reads the design's tokens; the Android app reads the neutral tokens
- one phase: the API, the web page and the Android app

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
success_measures:
  - a watering logged on one target shows on the other
  - a plant past its interval is marked due on both
sensitive_areas: none
tier_recommendation: T2
environments:
  - alpha
```
