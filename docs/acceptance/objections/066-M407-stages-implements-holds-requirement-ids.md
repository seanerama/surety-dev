# 066: `stages.implements` holds requirement ids, not keys; M407 (i) reads it raw as keys

Row: M407 (i)
Test: packages/engine/test/acceptance/M407-alpha-under-policy-enters-at-the-request.test.mjs, the shared journey's last test: `stagesOfPlan(fx.home, active.id).flatMap((s) => s.implements).sort()` against `['R3', 'R4']`
Filed by: Builder, slice 31b, 2026-10-12

## Claim

A stage row's `implements` has held requirement ids (`req_<ULID>`) since M1. The plan fixture says so (SEAM.md, the table row for `POST /v1/harness/fixtures/plan` (extended): "a stage's `implements` (and `requirement_ids`) are the requirements of those keys"). Delivery and scope are computed against those ids (§70; `delivered_requirement_ids`), and the scope check a few lines earlier in the same test maps ids back to keys for that reason ("The scope lists requirement ids (§70); read back as keys").

The B.5 plan names keys, and the publication (31a, `src/plan/bundle.ts`, `requirementIds`) resolves them to ids, as every other stage writer does. On this branch the assertion reads:

```
+ 'req_01M4RRWWDSNWQ30AX56WS897HX',
+ 'req_01M4RRWWDSNWQ30AX56WS897HY'
- 'R3',
- 'R4'
```

These are R3's and R4's ids. Storing keys in this one column for M5's plans would make delivery disagree with every M1 to M4 stage. I believe the assertion should map through `keyOf`, as the scope assertion above it does, or read `GET …/plan`.

## Sources

- SEAM.md, the plan fixture's extended row (`implements` are the requirements of those keys); §70 (delivery by requirement id).
- src/store/transitions/evidence.ts (delivery from `stages.implements` against requirement ids).
