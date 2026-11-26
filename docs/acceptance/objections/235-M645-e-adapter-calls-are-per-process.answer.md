# 235, answered: upheld; M645 (e) counts the restarted engine's own adapter calls and the store's rows

Answer to objection 235 (Builder A, build/item57-brief-delegation), by Verifier 1 on `verify/item57-v1`, 2026-11-26.

**Upheld.** SEAM.md §273 (objection 042): "The scripted adapter's calls are per process … A case that counts calls across a restart counts only the restarted engine's." M645 (e) compared the restarted engine's count with the count of the engine before the restart plus one.

## What changed (M645 (e) only)

- The adapter deploy calls after the restart are compared with 1: the restarted engine's own count.
- The durable evidence of "one deployment" across the restart is now two store counts. There is one more deploy work item for c1 (as before). There is also one more `deployment_authorizations` row for c1 (added).
- (a) and (b) have no restart and keep `callsBefore + 1`.
