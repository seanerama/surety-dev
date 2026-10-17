# 150: the retrofit inventory: how an interface the map cannot shape is declared, and the conformance stage's UI requirements

Row: M518 (e), (b) (slice 45)
Test: packages/engine/test/acceptance/M518-retrofit-the-observed-design.test.mjs; harness/design/retrofit45.mjs
Filed by: Verifier, slice 45, 2026-10-17 (a question for Sean, not a Builder's objection)

## Claim

D7 §12 gives two rules that reach the retrofit inventory, and both need a reading the text does not give.

**1. An interface the retrofit map cannot shape.** D7 §12 says the inventory of an adopted repository "needs the Architect's retrofit module map to state shapes and targets (§4.1); where it cannot, the inventory lists the interface with `shape: unknown` and the design check reports every screen using it (`DESIGN_INTERFACE_SHAPE_UNKNOWN`)". But G2's clause 5 refuses, under any `design` but `off`, a UI-consumed interface that lacks `request`, `response` or `errors` (`ARCH_INTERFACE_SHAPE_MISSING`, M508 (a)). Read literally, the retrofit map can never leave a shape out, so `shape: unknown` can never be reached. D7 does not say how the Architect marks "cannot".

What slice 45 pins (SEAM §528, †): in an adopted project's map, an interface may carry **`shape: "unknown"`** in place of `request`, `response` and `errors`. The plan check does not refuse it. The inventory lists it with `shape_known: false` and derives no obligation and no fixture from it ("unknown is a value; the engine does not invent a shape").

The other readings:
- (b) an interface with no shape is simply exempt from clause 5 in an adopted project, with no marker;
- (c) the marker is admitted in any project, not only an adopted one.

On `build/m6-s40` at `348ad12` the marker is refused `unknown_field` (expected: it is this slice's name).

**2. The conformance stage's UI requirements.** D7 §4.2, as slice 40 pins it (M502 (e)), makes an unmarked requirement that a UI stage implements a UI requirement of the inventory. A retrofit project has one conformance stage, over every module of the conformance set (D6 §8.1 step 3; §382). Once it carries the `web` module, every confirmed requirement it implements becomes a UI requirement, the library's and the health route's included. The design check then refuses `DESIGN_REQUIREMENT_UNCOVERED` for each unless a screen names it. This is what `build/m6-s40` does with Shelf.

What slice 45 does, without deciding it: Shelf's observed design maps R1 to R3 to the sum page, the service's front page, so the check passes either way. The test asserts nothing about which requirements are UI requirements.

**Asked:**
1. Is `shape: "unknown"` the declaration (and only in an adopted project's map), or one of the other readings?
2. In retrofit, should the conformance stage make its non-UI requirements UI requirements of the inventory? Or should only the marked ones (`**Surface:** ui`) be UI requirements there, given that the conformance stage builds nothing?

## Sources

- D7 §12; §4.1; §4.2; §8.3 clause 5 (G2); B.9 `shape_known`.
- M6 plan §3.7 M518 (e): "`shape: unknown` in the inventory; `DESIGN_INTERFACE_SHAPE_UNKNOWN` on every screen using it, with the same rule"; §3.2 M502 (e); §3.6 M508 (a).
- D6 §8.1 step 3; SEAM §382.
