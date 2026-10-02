# Verifier contract tables

Expected values the acceptance tests compare the engine against. They are derived from the sources (build spec §2) with the corrections in build spec §6, and from names the Verifier fixed where the sources were silent (recorded in `../harness/SEAM.md`). A test never reads the engine's own tables to learn what is legal or what a default is (build spec §4, Plan §2).

| File | Holds | Sources | First used by |
|---|---|---|---|
| `work-items.json` | The work-item transition table: each kind's path, the common templates limited to the statuses a kind reaches, Stop and Abandon from every run-owning status, the stored-continuation rule, the role of each M1 kind. Read through `../harness/transitions.mjs`. | D1 A.5, §4.3; build spec §6 #11; Review B10; F §4.1 | M09, M13, M14 (slice 2) |
| `run-lifecycle.json` | The run, execution-domain and lease tables; the reason classes and workspace disposition of each run outcome; what each outcome does to its work item in slice 2; what the expiry of a run lease leaves (`lease_expiry`). | D1 A.5, §§4.1, 4.5, 8.1, 8.3, 16; E7; E27 item 3; build spec §6 #1, #2, #12, #13; Review B08, B17 | M09–M18 (slice 2) |
| `run-end-faults.json` | The run-end fault matrix: the ten ways a run can end in slice 2, the store transactions on each ending's path (each named by an event it writes), what each ending leaves, and how long a faulted ending is given. Read through `../harness/endings.mjs`. | E28 item 1; D1 §§3.5, 3.6, 4.1, 4.3, 4.5, 10, 12.1; E27 items 3 and 5 | M15 (slice 3) |
| `config.json` | The closed configuration: every engine and ungoverned project key, its default, range and unit; the effective decision-target defaults of the eleven M1 decision kinds. | D1 A.9, A.8; build spec §6 #20; Review B17; E18; RN R2, R4 | M07 (slice 1) |

The remaining transition tables (attempt, journal, decision, intent, finding, proposal, assessment, authorization) are added by the slice that first generates cases from them. They must apply build spec §6 corrections 4, 14 and 16 to D1 A.5.
