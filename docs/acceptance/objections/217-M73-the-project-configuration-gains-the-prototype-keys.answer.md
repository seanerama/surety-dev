# 217, answered: upheld; the Verifier's key table gains the five prototype limit keys at the owner's values

Answer to `217-M73-the-project-configuration-gains-the-prototype-keys.md`, by the Verifier on `verify/rapid-prototype`, cut from the Builder's `build/rapid-prototype` 38121c19, 2026-10-28.

**Upheld.** The five keys are the owner's approved addition. Ruling R4 of 2026-10-28, verbatim: "Accept the proposed values as editable prototype defaults: 1.5 million billable tokens, $15 estimated spend, 45 minutes, two repairs per stage and four per iteration. These are configuration defaults, not authorization for a paid demonstration." The values the Builder states match R4 (45 minutes is 2,700 s), and they match the engine's `config/schema.ts` `PROJECT_POLICY`, the generated `api/schema.json` and `api/appendix-a.md`. The table was the only reason for the three failures: each file's other cases passed, each failing case's diff named only the five keys, and with the rows added each file passes.

## What changed (tests only; SEAM.md §572)

- **`contract/config.json`**, `project`: five rows, in the budget keys' style.

  | key | default | min | max | unit | integer |
  |---|---|---|---|---|---|
  | `prototype_budget_tokens` | 1500000 | 10000 | 50000000 | tokens | yes |
  | `prototype_budget_usd_estimated` | 15 | 0 | 10000 | usd | no (`integer: false`) |
  | `prototype_runtime_seconds` | 2700 | 300 | 86400 | s | yes |
  | `prototype_repairs_per_stage` | 2 | 0 | 10 | count | yes |
  | `prototype_repairs_per_iteration` | 4 | 0 | 40 | count | yes |

  The `$comment` records the addition and its source. Like the budget keys, the rows carry no `widening` field: that field marks the list keys (`egress_allow_extra`, `sandbox_read_paths`). That raising a number widens is pinned by M49, not by the table.
- **No case was added.** The keys' refusals (out of range, non-integer) and their widening when raised are covered for now by the Builder's developer test, `test/unit/rapid-prototype.test.mjs`. The slice that enforces the limits (E2) is where the Verifier will pin them in an acceptance row. This answer does not claim them.

## Runs

Each file was run alone with `node --test` on this branch, after `npm run build` (source unchanged), `TMPDIR=/tmp/rp-v`:

- M73-executable-contract: tests 11, pass 11, fail 0.
- M07-project-bootstrap-and-policy: tests 5, pass 5, fail 0.
- M01-kernel-journey: tests 11, pass 11, fail 0.
- M513-the-policy-and-its-keys: tests 5, pass 5, fail 0.
- M49-policy-widening-manifest: tests 5, pass 5, fail 0.

With the table as it was (stashed), M73-executable-contract and M01-kernel-journey each failed 1 of 11, as the objection reports.

## Sources

The owner's ruling R4 of 2026-10-28, quoted above (`PROPOSAL-2026-10-28.md` §7, as the objection cites it). `src/config/schema.ts` on 38121c19: the `PROJECT_POLICY` entries `prototype_budget_tokens: int(1_500_000, 10_000, 50_000_000)`, `prototype_budget_usd_estimated: { default: 15, min: 0, max: 10_000, integer: false }`, `prototype_runtime_seconds: int(2700, 300, 86_400)`, `prototype_repairs_per_stage: int(2, 0, 10)` and `prototype_repairs_per_iteration: int(4, 0, 40)`, with the comment "Raising one is a widening, as raising a budget key is". `api/appendix-a.md` and `api/schema.json` give the same defaults and ranges.
