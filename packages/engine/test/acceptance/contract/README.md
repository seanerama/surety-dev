# Verifier contract tables

Expected values the acceptance tests compare the engine against. They are derived from the sources (build spec §2) with the corrections in build spec §6, and from names the Verifier fixed where the sources were silent (recorded in `../harness/SEAM.md`). A test never reads the engine's own tables to learn what is legal or what a default is (build spec §4, Plan §2).

| File | Holds | Sources | First used by |
|---|---|---|---|
| `config.json` | The closed configuration: every engine and ungoverned project key, its default, range and unit; the effective decision-target defaults of the eleven M1 decision kinds. | D1 A.9, A.8; build spec §6 #20; Review B17; E18; RN R2, R4 | M07 (slice 1) |

Transition tables (work item per kind, run, domain, attempt, journal, decision, intent, finding, proposal, assessment, authorization) are added by the slice that first generates cases from them, starting with slice 2 (rows M09, M13, M14). They must apply build spec §6 corrections 4, 11, 12, 13, 14 and 16 to D1 A.5.
