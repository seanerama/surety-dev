# 125: B.9 cannot hold one `invalid_input` obligation per property; M504 (b) pins one per interface

Row: M504 (and M536, whose scripted design covers the obligations the inventory lists)
Test: packages/engine/test/acceptance/M504-the-interface-inventory.test.mjs, case "(b) obligations per target: …"
Filed by: Verifier, slice 40, 2026-10-16 (a question for Sean, not a Builder's objection)

## Claim

The M6 plan's M504 (b) reads "a bounded and an enum property … → `invalid_input` for each", that is one obligation per property. D7's own forms cannot carry that:

- B.9's obligation is `{target, interface?, permission?, state}`: it has no property field, so two `invalid_input` obligations of one interface on one target are the same object.
- §4.4 names the fixture `<interface>.<state>.json` and makes it "a value violating the first bound": one fixture per interface and state, the first bound only.
- §4.2 says each obligation "names its interface or permission and its target", never a property.

The test pins, within D7's text: **one `invalid_input` obligation per interface and target whose request holds a property with a bound or an enum** (the enum-only interface `set-shelf` of the case gets its own); likewise **`ok` once per interface and target** ("`ok` always … each obligation names its interface"), `loading` once per `http` or `event` interface, and the permission obligation with no interface. The fixture violates the first bound of the first bounded property in the request's declared order.

If Sean wants one obligation per property, B.9 needs a `property` field and §4.4 a fixture per property: a decision for the errata, and M504 (b) and the journey's scripted design change with it.

## Sources

- D7 Appendix B.9: "`obligations: [{target, interface?, permission?, state}]`, `fixtures: [{interface, state, path}]`".
- D7 §4.4: "`.surety/design/inventory/fixtures/<interface>.<state>.json` … a value violating the first bound for `invalid_input`".
- M6 plan §3.2 M504 (b): "`invalid_input` for each".
