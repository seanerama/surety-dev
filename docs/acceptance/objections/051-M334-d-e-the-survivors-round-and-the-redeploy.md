# 051: M334 (d)'s re-verification registers no check, because the survivor's identity differs, and (e)'s redeploy is refused by the critical finding the case's own check raised

Row: M334
Test: packages/engine/test/acceptance/M334-output-withheld-and-logs-redacted.test.mjs, case "(d), (e) S0 rotated to S1 …", assertions "the round registers its check, then refuses it" and (via `deployed`) "the deployment request is answered with an issued authorization"
Filed by: Builder, slice 28, 2026-10-11

## Claim

Two of the case's expectations contradict rules the accepted rows pin. On build/m4-s28, a copy of the case that changes only these two points passes, objection 048's exception included.

**1. No check is registered.** Before the kill, the case's plan releases `title-secret`, so the survivor's command line (`/proc/<pid>/cmdline`) carries S0. The case asserts that itself. The re-verification's first identity read therefore `differs` on `argv`. The build records `{"match": "differs", "detail": {"field": "argv", "withheld": "redaction_unavailable"}}`, with no value. A round whose first read does not match registers no checks and goes on to its second read. The assertion `executions.length > 0` cannot hold. Everything else the step asserts does hold in the copy: no check runs, nothing reaches the link, the survivor is read and the reads are recorded.

Suggested: accept either no execution of the round (the identity differs) or every one refused `redaction_unavailable`. Or release `title-secret` only after the re-verification's round, so that the round's checks are registered and refused.

**2. The redeploy is refused by the case's own finding.** The first deploy's check plan GETs `/secret`, so the service writes S0 into the check's response and the check's output holds it. The secret screen finds a held secret in that output, refuses its publication and raises a critical `security` finding (`evidence.secret_refused`, by `secret:deploy/m334_app`). This is D3 §2.6's behaviour as M218 pins it, and D4 §7.3 restates it for check output. The finding is open, so `alpha_authorize` reports `FINDING_BLOCKING` and (e)'s redeploy is 409 `authorization_not_issued`.

Suggested: disposition the finding before (e)'s redeploy. Or have the check fetch `/secret` without writing the body to its output. Or drop `/secret` from the check plan, since D4-S05's "a response to a check" is then the check's own business.

## Sources

- D4 §7.3: "the service's logs, check output and service-link logs are redacted before disk and screened before publication; a screen hit refuses that publication and raises the critical finding as for a role".
- SEAM.md §§207, 314; M218 (a held secret in a check's output: `evidence.secret_refused`, the critical finding).
- The verification round as built in slice 25 (E128 item 2; `roundFirstRead`): checks are registered only after a first read that matches. D4 §5.3: a round brackets its checks between two identity reads of the expected instance.
- D4 §3.4 step 4: arguments that differ from the configured start command read `differs`.
