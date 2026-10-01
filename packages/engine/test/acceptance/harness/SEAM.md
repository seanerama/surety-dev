# The test seam

**Owner:** the Verifier (build spec §4). **Written:** slice 1, 2026-10-01. Later slices extend it; a change to anything below is made by a Verifier session, normally in answer to an objection.

This file states exactly what the engine must provide for the acceptance tests to observe it (build spec §8). The tests are the contract; this file says in prose what they rely on. Where the sources (build spec §2) left a name, code, format or range open, the Verifier fixed it here; section 10 lists those choices. Everything else follows D1 Appendix A as corrected by build spec §6.

Paths are relative to the repository root unless they start with `$SURETY_HOME`.

---

## 1. The process

The tests run the built binary as `node packages/engine/dist/cli.js serve [flags]` with the working directory set to `$SURETY_HOME` and a constructed environment containing only `SURETY_HOME`, `PATH`, `HOME` (= `$SURETY_HOME`), `LANG=C.UTF-8` and `TZ=UTC`.

**Flags.** `--harness` enters harness mode (section 7). The flags below are accepted only together with `--harness`; given without it, or any unknown flag or command, the process exits with status **2** before doing anything else.

| Flag | Meaning |
|---|---|
| `--harness-migrations <dir>` | Read migrations from `<dir>` instead of `packages/engine/migrations/`. |
| `--harness-barrier <name>=<action>` | Arm a barrier at startup. Repeatable. `<action>` is `pause` or `kill`. |

**Exit statuses.**

| Status | When |
|---|---|
| 2 | Usage error: unknown command or flag, or a harness flag without `--harness`. |
| 3 | `engine_locked`: another live incarnation holds the lock (section 3). |
| 4 | The configuration was refused (section 2). |

**Startup refusals** (statuses 3 and 4) write one line to stderr that is a JSON object `{"code", "reason", "what_to_do", "subject"}`, the same shape as an API refusal. Other stderr lines may be logs; the tests take the last line that parses as a JSON object with a string `code`.

**Signals.** SIGKILL is used freely. SIGTERM is used to stop an engine before a test reads or copies its store; the tests do not pin what SIGTERM does beyond ending the process (they fall back to SIGKILL after 15 s).

**Engine home** (D1 §1.6). `$SURETY_HOME/config.json` (optional, written by the tests), `$SURETY_HOME/engine.lock`, `$SURETY_HOME/api.token`, `$SURETY_HOME/store.db` (with its `-wal` and `-shm` files).

## 2. Engine configuration

Engine-scope settings come from `$SURETY_HOME/config.json`, a JSON object. An absent file means every key takes its default. The file is read and validated **before** the lock is taken; a refused configuration exits with status 4 and writes nothing under `$SURETY_HOME`.

The closed key set, defaults, ranges and units are in `../contract/config.json` under `engine`. Values are JSON numbers in the unit stated there (durations are integer seconds, except `api_latency_bound` in milliseconds), except:

- `api_authority`: a string, exactly `127.0.0.1:<api_port>` or `localhost:<api_port>`. Default `127.0.0.1:<api_port>`. The API binds `127.0.0.1` regardless; the authority is what the Host check compares against.
- `body_cap`, `upload_cap`: fixed. Any other value is refused.
- `decision_targets`: an object mapping a `DecisionKind` (D1 A.2 plus `finding_applicability_exclusion` and `check_correction_tightening`) to an integer number of seconds in 300–2,592,000. `stop_confirm` and `abandon_confirm` have no target and cannot be given one. The effective map merges overrides over the defaults in `../contract/config.json` `decision_target_defaults` (`null` = no target).

**Validation.** Integers must be integers; `null` is never accepted for any key (it does not mean "default" or "unlimited"); strings are not coerced to numbers.

| Problem | `code` | `subject` |
|---|---|---|
| Unknown key | `unknown_field` | `{"field": "<key>"}` |
| Unknown decision kind | `unknown_field` | `{"field": "decision_targets.<kind>"}` |
| Wrong type, out of range, not allowed, `null`, fixed key changed | `invalid_value` | `{"field": "<key>"}` or `{"field": "decision_targets.<kind>"}` |

**Inspection.** `GET /v1/engine` returns `config`: an object with exactly one entry per engine key, each `{"value", "source"}` where `source` is `"file"` if the key was in `config.json` and `"default"` otherwise. For `decision_targets`, `value` is the effective map and `source` is `"file"` if any override was given.

**Project scope.** Ungoverned project keys (`../contract/config.json` `project`) are read with `GET /v1/projects/:p/policy`, which returns `{"effective": {<key>: <value>}, "revision": <the project's current policy revision number, or null if it has none>, ...}`, and changed with `POST /v1/projects/:p/policy`, whose body is an object of the keys to change. The submission is validated whole against the closed schema before anything else happens: an unknown key is `unknown_field`, any invalid value is `invalid_value`, both with `subject: {"field": "<key>"}` and HTTP 400, and a refused submission changes nothing (not the effective policy, the repository or the store). `max_concurrent_runs` accepts only `1` through M3 (E18). Slice 1 pins only refusals; a valid change commits through the journaled git path and is pinned in slice 3. Governed keys (`.surety/checks/protected-policy.json`, RN R2) are slice 5.

## 3. Engine lock and incarnation

`$SURETY_HOME/engine.lock` is a JSON object:

```json
{"incarnation_id": "inc_<ULID>", "pid": 12345, "pid_start_time": "987654", "started_at": "2026-10-01T12:00:00.000Z", "host_boot_id": "<uuid>"}
```

- `pid` is the pid of the `surety serve` process the test spawned.
- `pid_start_time` is field 22 of `/proc/<pid>/stat` (start time in clock ticks since boot), as a decimal string.
- `host_boot_id` is `/proc/sys/kernel/random/boot_id`, trimmed.

The lock is taken before the store is opened (D1 §1.3–1.4). An existing lock is held by a **live owner** when its `host_boot_id` equals the current boot id, a process with its `pid` exists, and that process's start time equals `pid_start_time`. Then the new process exits with status 3, `code: "engine_locked"`, `subject: {"incarnation_id": <the owner's>}`, and changes nothing: not the lock file, not the store (which it does not open). Otherwise the lock is **stale** and the new process takes it over without signalling the process named in it. Simultaneous starts produce exactly one owner.

Each incarnation that opens the store inserts one `engine_incarnations` row whose `id` is the lock's `incarnation_id` and whose `pid`, `started_at` and `host_boot_id` match the lock. `GET /v1/engine` reports it as `incarnation`.

## 4. Startup sequence and restricted mode

Steps, in order, with the names the engine reports (D1 §1.4): `lock`, `listen`, `store`, `recovery`, `integrity`, `full`, `scheduler`.

`GET /v1/engine` returns, among other fields:

| Field | Value |
|---|---|
| `version` | the engine version string |
| `incarnation` | the current incarnation id |
| `mode` | `"restricted"` or `"full"` |
| `harness` | `true` in harness mode, else `false` |
| `backends` | backends the engine would dispatch to; `[]` outside harness mode in M1 |
| `config` | section 2 |
| `startup.step` | the step in progress, or the failed step, or the last step once all completed |
| `startup.completed` | names of completed steps, in the order completed |
| `startup.failed` | `null`, or `{"step", "code", "reason", "subject"}` |

`GET /v1/health` returns 200 with `{"mode": ...}` in both modes.

**Restricted mode.** Only `GET /v1/health`, `GET /v1/engine` and the harness barrier routes answer; every other route returns **503** with `code: "engine_starting"` and `subject: {"step": <startup.step>}`. A failure in `store`, `recovery` or `integrity` leaves the engine running and restricted, with the failure in `startup.failed`; the scheduler is not started and `engine.started` is not emitted.

**Events.** Lifting to full mode emits `engine.mode_changed`; starting the scheduler emits `engine.started`, exactly once per incarnation.

## 5. Migrations

- Files in `packages/engine/migrations/` (or the `--harness-migrations` directory) whose names match `^(\d{4})_[a-z0-9_]+\.sql$`; the number is the order. Other files are ignored.
- All pending migrations are applied in one transaction at the `store` step, each recorded in table **`schema_migrations`** with columns `seq` (integer, the file's number), `name` (file name), `checksum` (lowercase hex SHA-256 of the file's bytes) and `applied_at` (timestamp format of section 8). A row is never rewritten.
- A migration that fails: `startup.failed = {"step": "store", "code": "migration_failed", "subject": {"migration": "<file name>"}}`; nothing from the batch is committed.
- An applied migration whose file is missing or whose checksum differs: `startup.failed = {"step": "store", "code": "migration_checksum_mismatch", "subject": {"migration": "<file name>"}}`.

## 6. HTTP API in slice 1

Every request, before routing or reading the body:

1. **Host.** The `Host` header, and the authority of an absolute-form request target if present, must equal `api_authority` exactly. Otherwise **400** `host_refused`.
2. **Token.** Header `X-Surety-Token` must equal the content of `$SURETY_HOME/api.token` (compared after trimming trailing whitespace from the file). Missing: **401** `token_required`. Present but wrong (including wrong length): **401** `token_invalid`. Every slice-1 route needs it, `GET /v1/health` included (D1 §11.1: every origin-less request).

`api.token` is created at first start before the listener starts, with mode 0600 (no group or other bits), holds at least 32 characters, and is unchanged by a restart.

**Refusals** are a top-level JSON object `{"code", "reason", "what_to_do", "subject"}` with non-empty `reason` and `what_to_do` (D1 §11.5). Status codes used in slice 1:

| Status | Codes |
|---|---|
| 400 | `host_refused`, `unknown_field`, `invalid_value` |
| 401 | `token_required`, `token_invalid` |
| 404 | `not_found` |
| 500 | `store_error`, `audit_failed` |
| 501 | `unsupported` |
| 503 | `engine_starting` |

**Audit.** Every mutating request (any method other than GET and HEAD) that passes the Host check, including every refusal after it, writes one `api.act` event with `actor_kind = "human"`, a non-null `request_id`, and `payload` containing at least `{"method", "path", "status"}`, where `path` is the request path without query string and `status` the HTTP status returned. No event row contains a presented token value. The response carries header `X-Surety-Request-Id` with the same request id, and the domain events the command writes carry the same `request_id`. If the `api.act` write fails, the mutation is refused with **500** `audit_failed` and has no effect. In restricted mode the store may not be open, so a `503 engine_starting` refusal needs no audit event.

**Routes slice 1 needs.**

| Route | Behavior |
|---|---|
| `GET /v1/health` | section 4 |
| `GET /v1/engine` | section 4 |
| `GET /v1/projects/:p/policy` | section 2 |
| `POST /v1/projects/:p/policy` | section 2 (refusals only in slice 1) |
| `POST /v1/projects/:p/pause`, `/resume` | Set or clear `projects.paused` and emit `project.paused` / `project.resumed` in the same transaction (D1 §8.4, §11.4). 200 on success. |
| `POST /v1/projects/:p/sessions`, `POST /v1/projects/:p/sessions/:r/turns`, `/save`, `/close` | **501** `unsupported` regardless of whether `:r` exists; no row written except the audit event. |
| `GET /v1/projects/:p/management`, `GET /v1/projects/:p/releases` | **501** `unsupported`. |
| Any request for deploy, publish, export or management activation | Refused with `unsupported` or `not_found`, no effect. M1 defines no route for them. |

A store failure inside a command's transaction is **500** `store_error` and leaves no partial change and no event of that transition.

## 7. Harness mode

Entered only by `--harness` at startup (build spec §8). `GET /v1/engine` reports `harness: true`. Outside harness mode every `/v1/harness/...` route is **404** `not_found` and has no effect, and the harness flags are a usage error.

Harness routes pass the same Host and token checks, write no `api.act` event, and are not part of `api/schema.json`.

| Route | Body | Result |
|---|---|---|
| `POST /v1/harness/fixtures/project` | `{"name", "tier", "dev_repo_path", "integration_branch"}` | **201** `{"project": {"id": "proj_<ULID>"}}`. A registered project on that repository, written by a transition that emits `project.created` with `subject.project` = the id and `payload.test_fixture = true`. The tests always pass a real git repository with one commit on the integration branch, which is checked out nowhere else; later slices' startup integrity must accept a project installed this way. |
| `POST /v1/harness/faults` | `{"point": "before_event", "event_type": "<EventType>"}` or `{"point": "audit_write"}` | **2xx**. Arms a one-shot fault. `before_event`: the next transaction that is about to append an event of that type fails after its domain writes and before the event write. `audit_write`: the next `api.act` write fails. |
| `GET /v1/harness/barriers` | — | **200** `{"barriers": [{"name", "action", "state"}]}`, `state` one of `armed`, `waiting`, `released`, `fired`. Answers in every mode. |
| `POST /v1/harness/barriers/:name/release` | `{}` | **2xx**. Releases a `pause` barrier that is `waiting`. Answers in every mode. |

**Barriers in slice 1.**

| Name | Where | Fires |
|---|---|---|
| `migration.before_commit` | In the `store` step, after every pending migration's SQL has run and its `schema_migrations` row has been inserted, before the transaction commits. | Only when at least one migration is pending. `kill`: the engine sends itself SIGKILL. `pause`: the store step waits until released while the listener keeps answering in restricted mode. |

Later slices add the barriers, scripted adapter and boundary, controlled clock and notification sink of build spec §8.

## 8. Store schema the tests write against

Rows M02, M03 and M04 open `$SURETY_HOME/store.db` directly with the pinned driver (`PRAGMA foreign_keys = ON`, `busy_timeout = 5000`) and insert rows. The schema must accept those inserts.

**Columns.** Table and column names are D1 A.3's. Every table has `id` (TEXT, primary key) and `created_at`. The project-scoped tables written by the tests have a `project` column (TEXT, NOT NULL, references `projects`): `work_items`, `runs`, `turns`, `execution_domains`, `capability_grants`, `invocation_receipts`, `invocation_status_observations`, `usage_observations`, `ledger_rows`, `operations`, `git_journal_events`. `events` has no required `project` column; a project-related event carries the project id at `subject.project`. Every A.3 field marked `*` is NOT NULL; every unmarked field, and any column the engine adds, is nullable or has a default. The tests supply exactly `id`, `created_at`, `project` where listed, and the `*` fields (`../harness/seed.mjs`).

**Value formats.** Ids: the A.1 prefix plus a 26-character ULID in Crockford base32. Timestamps: ISO-8601 UTC with milliseconds, `YYYY-MM-DDTHH:MM:SS.sssZ`. `day_utc`: `YYYY-MM-DD`. Booleans: integers 0 and 1. JSON-typed fields (`{}`, `[]` in A.3): JSON text. Shas: 40 lowercase hex. Enumerations: A.2 values. `events.tx`: an opaque string.

**Foreign keys.** Declared with `REFERENCES`. `turns`, `invocation_receipts` and `execution_domains` reference each other; the tests insert a turn, then its receipt, then its domain, in one transaction with `PRAGMA defer_foreign_keys = ON`, and the schema must accept that order.

**Constraints the tests pin** (build spec §6 correction 10; D1 §6.2):

- `invocation_receipts`: unique `run` where `turn IS NULL`; unique `turn` where `turn IS NOT NULL`; an insert is refused if `turn` is non-null and that turn's `run` differs from the receipt's `run` (the turn row exists by then), or if `turn` nullability disagrees with the run's `kind` (`one_shot` ⇔ null).
- `ledger_rows`: unique `invocation` where `corrects IS NULL`. A correction row (`corrects` set, `correction_seq` set) for the same invocation is accepted.
- Append-only: UPDATE and DELETE are refused on `invocation_receipts`, `invocation_status_observations`, `usage_observations`, `ledger_rows`, `git_journal_events` and `events`.

Every refusal must raise an error whose code starts with `SQLITE_CONSTRAINT` (a constraint, or a trigger using `RAISE(ABORT|FAIL|ROLLBACK, ...)`); a silently ignored write (`RAISE(IGNORE)`, `INSERT OR IGNORE`) fails the tests.

**Absent in M1.** `mechanic_issues`, `triage_dispositions`, `product_intent_contracts`, `adoption_analyses`, `export_records`, `promotion_records` (reserved, build spec §3), `observation_jobs`, `observation_history` (not built).

`stream_chunk_receipts` is not written by slice-1 tests: its parent is the pre-publication stream identity of build spec §6 correction 21, which slice 4 fixes.

## 9. Events

`events` columns are A.3's: `seq` (store-wide, strictly increasing), `at`, `type` (A.6), `subject` (JSON), `actor_kind`, `actor_id`, `request_id`, `operation`, `payload` (JSON), `tx`. Slice-1 tests read `project.created`, `project.paused`, `project.resumed`, `engine.started`, `engine.mode_changed` and `api.act`. They tolerate `engine.tick` appearing at any time.

## 10. Names the Verifier fixed in slice 1

Each of these was open in the sources (build spec §4, "Who decides what the sources leave open"). The Builder may object.

| What | Fixed as | Why this choice |
|---|---|---|
| CLI command and harness flags | `surety serve`, `--harness`, `--harness-migrations`, `--harness-barrier` | D1 §1.1 names `surety serve`; flags are the plainest form. |
| Exit statuses | 2 usage, 3 `engine_locked`, 4 configuration refused | The scaffold already uses 2 for an unknown command. |
| Where engine config lives | `$SURETY_HOME/config.json`, read before the lock | The port must be known at step 2, before the store opens at step 3 (D1 §1.4), so it cannot live only in the store's `config` table. |
| New engine keys | `api_port`, `api_authority`, `git_deadline`, `git_deadline_long`, `git_output_cap`, `decision_targets` | Correction 20 and Review B17 require them; D1 §7.1 gives the 60 s and 600 s git deadlines. |
| New project keys | `snapshot_max_files`, `snapshot_max_bytes`, `snapshot_max_file_bytes` | D1 §7.3 step 5 "size and kind caps per policy". Kind caps are not separately configurable. |
| Ranges and units | `../contract/config.json` | A.9 where given, converted to seconds; otherwise the Verifier's choice, recorded there. |
| Decision-target defaults for the two RN R4 kinds | 1 day each | The same as their siblings in A.8 (`finding_disposition`; `check_correction_*`). |
| Config error codes | `unknown_field` (A.7), `invalid_value` (new) | A.7 has no code for a bad value. |
| Excluded-capability code | `unsupported`, HTTP 501 | No A.7 code fits; build spec §3 calls these "present only as a refusal". |
| Startup step names | `lock`, `listen`, `store`, `recovery`, `integrity`, `full`, `scheduler` | D1 §1.4's seven steps. |
| Migration table and failure codes | `schema_migrations(seq, name, checksum, applied_at)`; `migration_failed`, `migration_checksum_mismatch` | Correction 19 requires the table; D1 names neither. |
| Migration file names | `NNNN_name.sql` | Build spec §5 says "numbered .sql files". |
| Lock record | adds `pid_start_time` to D1 §1.3's fields | Distinguishing a reused pid (Plan M06) needs the process start time. |
| HTTP status codes | section 6 table | D1 fixes only 503 for `engine_starting`. |
| Request id header | `X-Surety-Request-Id` | D1 §12.1 requires events to name the request; the header lets a client tie a response to its audit record. |
| `api.act` payload keys | `method`, `path`, `status` | Plainest attributable record. |
| Fixture label | `project.created` with `payload.test_fixture = true` | Build spec §3: fixtures are "clearly labeled". |
| Harness routes, faults, barrier | section 7 | Build spec §8 leaves the mechanism to the Verifier. |
| Project-scoped tables carry `project` | section 8 list | A.3: "every project-scoped table has `project`"; the list makes it explicit. |
