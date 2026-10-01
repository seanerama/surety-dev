# Objections

A Builder who believes an acceptance test is wrong files an objection here instead of working around the test (foundations §4.2, build spec §4).

**The Builder** commits one file per objection on its build branch, named `NNN-<row>-<slug>.md`, for example `001-M04-event-orphan.md`:

```
# NNN: <one-line claim>

Row: M04
Test: packages/engine/test/acceptance/M04-append-only.test.mjs, case "<name>"
Filed by: Builder, slice 1, <date>

## Claim
What the test requires, and what you believe it should require.

## Sources
The text that supports the claim, quoted with its location.
```

**The Verifier** answers on its own branch, cut from `main`, in a separate file named `NNN-<row>-<slug>.answer.md`, so the two branches never edit the same file. The answer cites sources and says either that the objection is upheld and which test changed, or that it is declined and why.

**Sean** merges the Verifier's branch and, if the two still disagree, decides. His decision is added to the answer file.

An open objection does not make a failing test pass. The row stays failing until the Verifier changes the test or the Builder changes the engine.
