# 168: M507 (g) decides that a gate delivers R2 by finding the two characters "R2" anywhere in its inputs snapshot, IDs included

Row: M507 (g)
Test: packages/engine/test/acceptance/M507-design-readiness-and-the-third-milestone.test.mjs, case (g), its last line
Filed by: Builder, slice 40, 2026-10-17

## Claim

```js
if (applied === 0) for (const e of after().filter((x) => x.inputs_snapshot.includes('R2'))) assert.ok(named(e), …);
```

`inputs_snapshot` is the gate's JSON. It holds ULIDs and other identifiers (check result ids `cr_…`, candidate ids, hashes), and ULIDs are Crockford base32, upper case, so "R2" occurs inside one by chance. A gate of a stage that does not deliver R2 then counts as "delivering R2". It does not name R2.2, rightly, and the case fails.

Observed in a kept store (`b40c9` run 1), the failing case's message:

```
every gate delivering R2 names it while its checks do not exist (stage: [{"code":"SIGNOFF_MISSING","subjects":["cand_01M54M5VG4T04E2QMFWKR04HN6"]}])
```

That gate is stage 1's (the API stage: R1 only; its reasons, SIGNOFF_MISSING alone, are right). Every occurrence of "R2" in its snapshot is inside an id:

```
3 stage stage 1 not_satisfied [{"code":"SIGNOFF_MISSING", …}]
   R2 at: ["54M5PTRQCRJVE4VGPS08SW1\":\"cr_01M54M5WGBRR29T5C3Q9TKW"]   ← "…GBRR29…"
```

Stage 2's gate in the same window names R2.2 and R2.3 as the case requires. Stage 3's names R3.2 and has no "R2".

A second kept failure (`b40c10` run 2) is the same: stage 1's gate matched inside `cr_01M54M7PR255YEKAGV9M…`. **In neither store does any snapshot hold a requirement key as text.** Stage 2's snapshot had no "R2" at all in run 2, and only an id's "R2" (`cr_01M54M5WSFPS2MPZR2XF…`) in run 1. So the filter never selects a gate because the gate delivers R2. It selects exactly the gates whose ids happen to contain "R2", and the assertion checks nothing it means to check.

How often it fails depends on the ids an engine happens to generate, and on which gates fall in the window after the mark. On this workstation: 3 runs in 12 of the whole file (every failure of the file was this case), and 2 runs in 13 of (g) alone. The engine is not involved: the assertion's subject is chosen by a substring match.

## What the test can do

Decide "delivers R2" from the gate's stage, not from the snapshot's text: a stage gate whose `stage` is a stage of the published plan that `implements` R2 (stage 2 of the reference plan), or a phase gate of the phase holding R2. Never use `includes('R2')` on the JSON.

## Sources

- M507 (g) as written; the reference plan's stages (harness/design/reference.mjs `STAGES`).
